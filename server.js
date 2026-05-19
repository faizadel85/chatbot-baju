const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const WASSENGER_TOKEN = process.env.WASSENGER_TOKEN;
const SHEET_ID = "1lz5K8te2CihyjBcHht4FH4j21Sir1EzNwapGlIQfvb8";
const sesi = {};

// ===== GUARDRAIL =====
function detectPromptInjection(text) {
  var attacks = [
    "ignore previous", "ignore above", "ignore all",
    "forget previous", "forget instructions", "forget all",
    "new instructions", "new rules", "override instructions",
    "system prompt", "reveal prompt", "show prompt",
    "pretend you are", "act as", "you are now",
    "jailbreak", "dan mode", "developer mode",
    "ignore your training", "bypass", "disregard",
    "abaikan arahan", "tukar peranan", "jadi ai lain",
    "tunjuk prompt", "dedahkan sistem", "lupakan arahan",
    "abaikan semua", "arahan baru", "peranan baru"
  ];
  var textLower = text.toLowerCase();
  return attacks.some(function(attack) {
    return textLower.includes(attack);
  });
}

// ===== GOOGLE AUTH =====
async function getGoogleAuth() {
  var credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  var auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return auth;
}

// ===== CACHE =====
var sheetCache = {};
var CACHE_DURATION = 1 * 60 * 1000;

async function getSheetDataCached(sheetName) {
  var now = Date.now();
  if (sheetCache[sheetName] && (now - sheetCache[sheetName].time) < CACHE_DURATION) {
    return sheetCache[sheetName].data;
  }
  var data = await getSheetData(sheetName);
  sheetCache[sheetName] = { data: data, time: now };
  return data;
}

// ===== SIMPAN SESI =====
async function simpanSesi(phoneNumber, messages) {
  try {
    var auth = await getGoogleAuth();
    var sheets = google.sheets({ version: "v4", auth });
    var result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sessions!A:A"
    });
    var rows = result.data.values || [];
    var rowIndex = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === phoneNumber) {
        rowIndex = i + 1;
        break;
      }
    }
    var now = new Date().toISOString();
    var messagesJson = JSON.stringify(messages.slice(-20));
    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "Sessions!A" + rowIndex + ":C" + rowIndex,
        valueInputOption: "RAW",
        resource: { values: [[phoneNumber, now, messagesJson]] }
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Sessions!A:C",
        valueInputOption: "RAW",
        resource: { values: [[phoneNumber, now, messagesJson]] }
      });
    }
  } catch (err) {
    console.error("Error simpan sesi:", err);
  }
}

// ===== LOAD SESI =====
async function loadSesi(phoneNumber) {
  try {
    var auth = await getGoogleAuth();
    var sheets = google.sheets({ version: "v4", auth });
    var result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sessions!A:C"
    });
    var rows = result.data.values || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === phoneNumber) {
        var messages = JSON.parse(rows[i][2] || "[]");
        var lastUpdated = new Date(rows[i][1]);
        var now = new Date();
        var diff = (now - lastUpdated) / (1000 * 60 * 60);
        if (diff > 24) return [];
        return messages;
      }
    }
    return [];
  } catch (err) {
    console.error("Error load sesi:", err);
    return [];
  }
}

// ===== SIMPAN ORDER =====
async function simpanOrder(data) {
  try {
    var auth = await getGoogleAuth();
    var sheets = google.sheets({ version: "v4", auth });
    var tarikh = new Date().toLocaleString("ms-MY", { timeZone: "Asia/Kuala_Lumpur" });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Orders!A:O",
      valueInputOption: "RAW",
      resource: {
        values: [[
          tarikh,
          data.nama || "",
          data.noTel || "",
          data.alamat || "",
          data.poskod || "",
          data.bandar || "",
          data.negeri || "",
          data.produk || "",
          data.saiz || "",
          data.warna || "",
          data.harga || "",
          data.kaedahBayar || "",
          data.penamaakaun || "",
          "Baru",
          data.nota || ""
        ]]
      }
    });
    console.log("Order disimpan!");

    var notifMsg = "ORDER BARU!\n\n" +
      "Nama: " + (data.nama || "") + "\n" +
      "No Tel: " + (data.noTel || "") + "\n" +
      "Produk: " + (data.produk || "") + "\n" +
      "Warna: " + (data.warna || "") + "\n" +
      "Saiz: " + (data.saiz || "") + "\n" +
      "Harga: RM" + (data.harga || "") + "\n" +
      "Postage: RM" + (data.postage || "") + "\n" +
      "Total: RM" + (data.total || "") + "\n\n" +
      "Alamat: " + (data.alamat || "") + "\n" +
      "Poskod: " + (data.poskod || "") + "\n" +
      "Bandar: " + (data.bandar || "") + "\n" +
      "Negeri: " + (data.negeri || "") + "\n\n" +
      "Kaedah Bayar: " + (data.kaedahBayar || "") + "\n" +
      "Penama Akaun: " + (data.penamaakaun || "") + "\n" +
      "Nota: " + (data.nota || "");

    await hantarMesej("601123726341", notifMsg);
    console.log("Notif admin dihantar!");
  } catch (err) {
    console.error("Error simpan order:", err);
  }
}

// ===== HANTAR MESEJ =====
async function hantarMesej(phoneNumber, mesej) {
  var cuba = 0;
  while (cuba < 3) {
    try {
      await axios.post(
        "https://api.wassenger.com/v1/messages",
        { phone: phoneNumber, message: mesej },
        { headers: { Token: WASSENGER_TOKEN } }
      );
      return;
    } catch (err) {
      cuba++;
      console.error("Error hantar mesej cuba " + cuba + ":", err.message);
      if (cuba < 3) {
        await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      }
    }
  }
}

// ===== STAGE FOLLOW UP =====
var followUpQueue = {};

var MSG_STAGE1 = "Assalamualaikum Cik cari size dan warna apa ya?\n\nAtau nak saya bantu dapatkan size yg sesuai untuk Cik?";
var MSG_STAGE2 = "Assalamualaikum! Semoga Cik dalam keadaan baik & semoga urusan kita sama dipermudahkan hari ini\n\nCik ada tekan link iklan saya dari FB/IG. Saya sangat-sangat hargai respon Cik\n\nCik tengah cari warna dan size apa ya? Ada apa boleh saya bantu?";
var MSG_STAGE3A = "Salam Cik\n\nSaya nak follow-up order Cik tadi ya. Untuk proceed packing, boleh send resit payment bila sempat\n\nStock design ni tengah laju keluar hari ni";
var MSG_STAGE3B = "Salam Cik\n\nOrder Cik masih available ya buat masa sekarang\n\nBila payment dah settle nanti boleh terus send resit dekat saya supaya team boleh reserve & packing cepat";

setInterval(async function() {
  var now = Date.now();
  for (var phone in followUpQueue) {
    var q = followUpQueue[phone];
    if (q.done) continue;

    if (q.stage === "browsing") {
      if (!q.sent1 && (now - q.lastReply) >= 60 * 60 * 1000) {
        await hantarMesej(phone, MSG_STAGE1);
        followUpQueue[phone].sent1 = true;
        console.log("Stage 1 sent to " + phone);
      }
      if (q.sent1 && !q.sent2 && (now - q.lastReply) >= 24 * 60 * 60 * 1000) {
        await hantarMesej(phone, MSG_STAGE2);
        followUpQueue[phone].sent2 = true;
        followUpQueue[phone].done = true;
        console.log("Stage 2 sent to " + phone);
      }
    }

    if (q.stage === "ordered") {
      if (!q.sent3a && (now - q.orderedAt) >= 60 * 60 * 1000) {
        await hantarMesej(phone, MSG_STAGE3A);
        followUpQueue[phone].sent3a = true;
        console.log("Stage 3a sent to " + phone);
      }
      if (q.sent3a && !q.sent3b && (now - q.orderedAt) >= 4 * 60 * 60 * 1000) {
        await hantarMesej(phone, MSG_STAGE3B);
        followUpQueue[phone].sent3b = true;
        followUpQueue[phone].done = true;
        console.log("Stage 3b sent to " + phone);
      }
    }
  }
}, 30 * 1000);

// ===== GOOGLE SHEET =====
async function getSheetData(sheetName) {
  try {
    var url = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/gviz/tq?tqx=out:csv&sheet=" + encodeURIComponent(sheetName);
    var response = await axios.get(url);
    var lines = response.data.split("\n");
    var headers = lines[0].split(",").map(function(h) { return h.replace(/"/g, "").trim(); });
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var values = lines[i].split(",").map(function(v) { return v.replace(/"/g, "").trim(); });
      var row = {};
      for (var j = 0; j < headers.length; j++) {
        row[headers[j]] = values[j] || "";
      }
      rows.push(row);
    }
    return rows;
  } catch (err) {
    console.error("Sheet error:", err);
    return [];
  }
}

// ===== SYSTEM PROMPT =====
function buatSystemPrompt(products, sizeChart, produkDetail, sizeChartImages) {
  var senaraiProduk = products.map(function(p) {
    return p.Nama + " | Warna: " + p.Warna +
      " | Harga XS-2XL: RM" + p.Harga_XS_2XL +
      " | Harga 3XL-4XL: RM" + p.Harga_3XL_4XL + " (ADD ON RM10)" +
      " | Stok: XS=" + p.Stock_XS + " S=" + p.Stock_S +
      " M=" + p.Stock_M + " L=" + p.Stock_L +
      " XL=" + p.Stock_XL + " 2XL=" + p.Stock_2XL +
      " 3XL=" + p.Stock_3XL + " 4XL=" + p.Stock_4XL;
  }).join("\n");

  var sizeInfo = {};
  sizeChart.forEach(function(row) {
    if (!sizeInfo[row.Ukuran]) sizeInfo[row.Ukuran] = {};
    ["XS","S","M","L","XL","2XL","3XL","4XL"].forEach(function(s) {
      sizeInfo[row.Ukuran][s] = row[s] || "";
    });
  });

  var sizeText = "Panduan Saiz:\n";
  Object.keys(sizeInfo).forEach(function(ukuran) {
    sizeText += ukuran + ": " + ["XS","S","M","L","XL","2XL","3XL","4XL"].map(function(s) {
      return s + "=" + sizeInfo[ukuran][s];
    }).join(", ") + "\n";
  });

  var detailText = "Detail Produk:\n";
  produkDetail.forEach(function(p) {
    detailText += p.Nama +
      " | Material: " + p.Material +
      " | Cutting: " + p.Cutting +
      " | Feature: " + p.Feature +
      " | Sesuai untuk: " + p.Sesuai_Untuk + "\n";
  });
console.log("Detail produk loaded:", detailText);

  return "Kamu adalah pembantu jualan kedai baju ADEL Adyana Elegance. Jawab dalam Bahasa Malaysia Baku yang ringkas, mesra dan profesional.\n" +
    "PENTING: Panggil pelanggan sebagai Cik sahaja.\n" +
    "BAHASA: Gunakan HANYA Bahasa Malaysia. DILARANG guna perkataan Indonesia seperti cocok, oke, yuk, dong, sih, deh, banget, sesuai banget.\n" +
    "GAYA: Ayat pendek, mudah faham, profesional. Maksimum 3-4 ayat per jawapan.\n\n" +
    "PRODUK:\n" + senaraiProduk + "\n\n" +
    "PANDUAN SAIZ:\n" + sizeText + "\n\n" +
    "DETAIL PRODUK:\n" + detailText + "\n\n" +
    "PERATURAN:\n" +
    "- Bila pelanggan mula masuk, hantar gambar katalog dan senarai nama baju sahaja — JANGAN sebut harga\n" +
    "- Harga HANYA sebut bila pelanggan tanya atau dah setuju nak beli\n" +
    "- Bila pelanggan tanya warna — senaraikan warna yang ada SAHAJA, JANGAN hantar gambar dulu\n" +
    "- Bila pelanggan pilih warna specific baru sebut: Ini gambar [nama baju] warna [warna] untuk Cik\n" +
    "- Tanya berat badan (kg) dan ukuran dada (INCHI) untuk recommend saiz\n" +
    "- Semua ukuran dalam INCHI bukan cm\n" +
    "- Jika stok = 0 untuk warna/saiz yang dipilih:\n" +
    "  1. Beritahu stok habis\n" +
    "  2. Cadang warna lain yang sama baju\n" +
    "  3. Kalau tak nak, cadang baju lain warna lebih kurang sama\n" +
    "- Saiz 3XL dan 4XL ada tambahan RM10\n" +
    "- Kaedah Pembayaran: Bank Transfer atau COD\n" +
    "- COD: Tambah RM4 kepada kos postage\n" +
    "- Kadar Postage Semenanjung: 1pcs RM6, 2-5pcs RM4/pcs, 6pcs ke atas RM2/pcs\n" +
    "- Kadar Postage Sabah & Sarawak: 1pcs RM13, 2-5pcs RM8/pcs, 6pcs ke atas RM6/pcs\n" +
    "- Tanya pelanggan kaedah pembayaran: Bank Transfer atau COD\n" +
    "- Maklumat Akaun Bank untuk Transfer:\n" +
    "  Bank: MAYBANK\n" +
    "  Nama: Adel Adyana Elegance\n" +
    "  No Akaun: 551100323485\n" +
    "- Selepas transfer, minta pelanggan hantar gambar resit dan nama penama akaun bank\n" +
    "- LARANGAN MUTLAK: JANGAN tulis URL, link, http, www dalam jawapan\n" +
    "- LARANGAN MUTLAK: JANGAN cipta URL gambar sendiri\n" +
    "- LARANGAN MUTLAK: JANGAN tulis format markdown atau bold dalam jawapan\n" +
    "- LARANGAN MUTLAK: JANGAN tulis perkataan sistem, akan hantar, kurungan dalam jawapan\n" +
    "- Flow order yang BETUL:\n" +
    "  1. Pelanggan confirm nak beli\n" +
    "  2. Tanya lokasi: Semenanjung atau Sabah/Sarawak\n" +
    "  3. Kira jumlah postage dan beritahu total\n" +
    "  4. Tanya kaedah pembayaran: Bank Transfer atau COD\n" +
    "  5. Bagi info pembayaran dengan jumlah total\n" +
    "  6. Bila pelanggan pilih COD, terus tulis ORDER_COD_CONFIRMED dalam jawapan\n" +
    "  6b. Bila pelanggan hantar resit Bank Transfer, tulis ORDER_RECEIPT_RECEIVED dalam jawapan\n" +
    "  7. Minta details penghantaran (nama, no telefon, alamat, poskod, bandar, negeri)\n" +
    "  8. Bila semua details lengkap, tulis: ORDER_CONFIRMED:nama|notel|alamat|poskod|bandar|negeri|produk|saiz|warna|harga|postage|total|kaedahbayar|penamaakaun|nota\n" +
    "- JANGAN minta details penghantaran sebelum pelanggan hantar resit atau confirm COD\n" +
    "- Bila pelanggan bagi details penghantaran, JANGAN tanya semula produk\n" +
    "- Jika pelanggan tanya size chart, jawab HANYA: Ini size chart untuk Cik\n" +
    "- WAJIB: Setiap jawapan mesti ada soalan susulan\n" +
    "- JANGAN guna markdown atau asterisk dalam jawapan\n" +
    "- Jawapan mesti dalam teks biasa sahaja\n" +
    "- LARANGAN MUTLAK: JANGAN guna perkataan cocok, oke, yuk, dong, sih, deh, banget — guna Bahasa Malaysia sepenuhnya";
}

// ===== WEBHOOK =====
app.post("/webhook", async function(req, res) {
  try {
    var data = req.body;

    if (data.event !== "message:in:new") return res.sendStatus(200);
    if (data.data.fromMe) return res.sendStatus(200);

    var from = data.data.chatId || data.data.from || "";
    var text = data.data.body || data.data.text || "";
    var hasMedia = data.data.hasMedia || data.data.type === "image" || data.data.type === "document";
    var phoneNumber = from.replace("@c.us", "").replace("@s.whatsapp.net", "");

    // Kalau hantar gambar/media — anggap sebagai resit
    if (!text && hasMedia) {
      console.log("Media received from: " + phoneNumber);
      console.log("Current stage: " + (followUpQueue[phoneNumber] ? followUpQueue[phoneNumber].stage : "no queue"));

      if (followUpQueue[phoneNumber] && followUpQueue[phoneNumber].stage === "ordered") {
        followUpQueue[phoneNumber].stage = "paid";
        followUpQueue[phoneNumber].done = true;
        followUpQueue[phoneNumber].sent3a = true;
        followUpQueue[phoneNumber].sent3b = true;
        console.log("Stage tukar ke paid untuk: " + phoneNumber);
        await hantarMesej(phoneNumber, "Terima kasih Cik! Resit dah kami terima. Boleh Cik berikan nama penuh dan alamat penghantaran? 😊");
      }
      return res.sendStatus(200);
    }

    if (!from || !text) return res.sendStatus(200);

    // Check prompt injection
    if (detectPromptInjection(text)) {
      console.log("Prompt injection detected dari: " + phoneNumber);
      await hantarMesej(phoneNumber, "Maaf Cik, saya hanya boleh membantu berkaitan produk dan pesanan ADEL Adyana Elegance sahaja. Ada apa yang boleh saya bantu? 😊");
      await hantarMesej("601123726341", "PROMPT INJECTION DETECTED!\nNo: " + phoneNumber + "\nMesej: " + text);
      return res.sendStatus(200);
    }

    // Detect request penukaran
    var katatukar = [
      "nak tukar", "nk tukar", "tukar alamat", "tukar baju",
      "tukar saiz", "tukar size", "tukar warna", "ubah alamat",
      "ubah baju", "ubah saiz", "ubah size", "ubah warna",
      "salah alamat", "salah saiz", "salah size", "salah baju",
      "salah warna", "boleh tukar", "boleh ubah", "cancel", "batalkan"
    ];

    var adaPenukaran = katatukar.some(function(kata) {
      return text.toLowerCase().includes(kata);
    });

    if (adaPenukaran) {
      var notifTukar = "PERHATIAN - REQUEST PENUKARAN!\n\nNo Tel: " + phoneNumber + "\nMesej: " + text + "\n\nSila semak dan hubungi pelanggan segera!";
      await hantarMesej("601123726341", notifTukar);
      console.log("Notif penukaran dihantar!");
    }

    // Setup follow up queue
    if (!followUpQueue[phoneNumber]) {
      followUpQueue[phoneNumber] = {
        stage: "browsing",
        lastReply: Date.now(),
        sent1: false,
        sent2: false,
        sent3a: false,
        sent3b: false,
        done: false
      };
    } else {
      if (followUpQueue[phoneNumber].stage === "browsing") {
        followUpQueue[phoneNumber].lastReply = Date.now();
        followUpQueue[phoneNumber].sent1 = false;
        followUpQueue[phoneNumber].sent2 = false;
        followUpQueue[phoneNumber].done = false;
      } else if (followUpQueue[phoneNumber].stage === "ordered") {
        followUpQueue[phoneNumber].lastReply = Date.now();
        // JANGAN reset sent3a dan sent3b
      } else if (followUpQueue[phoneNumber].stage === "paid") {
        // Dah bayar — jangan buat apa-apa
      }
    }

    // Load sesi
    if (!sesi[phoneNumber]) {
      sesi[phoneNumber] = await loadSesi(phoneNumber);
    }

    sesi[phoneNumber].push({ role: "user", content: text });

    // Detect pelanggan baru — hantar katalog terus
    var isFirstMessage = sesi[phoneNumber].length === 1;
    if (isFirstMessage) {
      var katalogIntro = await getSheetDataCached("Katalog");

      // Semak kalau pelanggan sebut nama baju specific
      var bajuDisebut = null;
      katalogIntro.forEach(function(k) {
        if (text.toLowerCase().includes(k.Nama.toLowerCase())) {
          bajuDisebut = k;
        }
      });

      if (bajuDisebut && bajuDisebut.Gambar_URL) {
        // Hantar gambar katalog baju yang disebut je
        await axios.post(
          "https://api.wassenger.com/v1/messages",
          {
           phone: phoneNumber,
           message: bajuDisebut.Nama,
           media: { url: bajuDisebut.Gambar_URL }
         },
      { headers: { Token: WASSENGER_TOKEN } }
    );
  } else {
    // Tak sebut nama baju — hantar semua katalog
    for (var ki = 0; ki < katalogIntro.length; ki++) {
      if (katalogIntro[ki].Gambar_URL) {
        await axios.post(
          "https://api.wassenger.com/v1/messages",
          {
            phone: phoneNumber,
            message: katalogIntro[ki].Nama,
            media: { url: katalogIntro[ki].Gambar_URL }
          },
          { headers: { Token: WASSENGER_TOKEN } }
        );
        await new Promise(function(resolve) { setTimeout(resolve, 1000); });
      }
    }
  }
}

    var products = await getSheetDataCached("Sheet1");
    var sizeChart = await getSheetDataCached("Size Chart");
    var produkDetail = await getSheetDataCached("produkDetail");
    var sizeChartImages = await getSheetDataCached("sizeChartImages");
    var systemPrompt = buatSystemPrompt(products, sizeChart, produkDetail, sizeChartImages);

    // Retry 3 kali
    var response;
    var cuba = 0;
    while (cuba < 3) {
      try {
        response = await claude.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          temperature: 0,
          system: systemPrompt,
          messages: sesi[phoneNumber]
        });
        break;
      } catch (retryErr) {
        cuba++;
        if (cuba === 3) throw retryErr;
        await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      }
    }

    var jawapan = response.content[0].text;
    sesi[phoneNumber].push({ role: "assistant", content: jawapan });

    // Simpan sesi
    await simpanSesi(phoneNumber, sesi[phoneNumber]);

   // Kalau bot jawab semua warna sekaligus — trigger katalog warna
   var kataSemuaWarna = ["semua warna", "ini semua warna", "pelbagai warna"];
   var jawabSemuaWarna = kataSemuaWarna.some(function(kata) {
     return jawapan.toLowerCase().includes(kata);
   });

   if (jawabSemuaWarna) {
     var historyTextWarna = sesi[phoneNumber].map(function(m) {
       return m.content;
     }).join(" ").toLowerCase();

     var bajuWarna = null;
     var lastIdxW = -1;
     var uniqueNamaW = [];
     products.forEach(function(p) {
       if (uniqueNamaW.indexOf(p.Nama) === -1) uniqueNamaW.push(p.Nama);
     });
     uniqueNamaW.forEach(function(nama) {
       var idx = historyTextWarna.lastIndexOf(nama.toLowerCase());
       if (idx > lastIdxW) { lastIdxW = idx; bajuWarna = nama; }
     });

     if (bajuWarna) {
       var warnaListW = [];
       products.forEach(function(p) {
         if (p.Nama.toLowerCase() === bajuWarna.toLowerCase() && p.Gambar_URL) {
           warnaListW.push(p);
         }
       });
       for (var ww = 0; ww < warnaListW.length; ww++) {
         await axios.post(
           "https://api.wassenger.com/v1/messages",
           { phone: phoneNumber, message: warnaListW[ww].Warna, media: { url: warnaListW[ww].Gambar_URL } },
           { headers: { Token: WASSENGER_TOKEN } }
        );
       await new Promise(function(resolve) { setTimeout(resolve, 1000); });
     }
     await hantarMesej(phoneNumber, "Ini semua warna " + bajuWarna + " untuk Cik 😊\n\nCik suka warna yang mana?");
     return res.sendStatus(200);
   }
 }

    // Detect COD confirmed
    if (jawapan.includes("ORDER_COD_CONFIRMED")) {
      followUpQueue[phoneNumber].stage = "ordered";
      followUpQueue[phoneNumber].orderedAt = Date.now();
      followUpQueue[phoneNumber].sent3a = false;
      followUpQueue[phoneNumber].sent3b = false;
      followUpQueue[phoneNumber].done = false;
      jawapan = jawapan.replace("ORDER_COD_CONFIRMED", "").trim();
    }

    // Detect resit diterima
    if (jawapan.includes("ORDER_RECEIPT_RECEIVED")) {
      followUpQueue[phoneNumber].stage = "paid";
      followUpQueue[phoneNumber].done = true;
      jawapan = jawapan.replace("ORDER_RECEIPT_RECEIVED", "").trim();
    }

    // Detect order confirmed
    if (jawapan.includes("ORDER_CONFIRMED:")) {
      var orderData = jawapan.split("ORDER_CONFIRMED:")[1].split("|");
      await simpanOrder({
        nama: orderData[0] || "",
        noTel: orderData[1] || "",
        alamat: orderData[2] || "",
        poskod: orderData[3] || "",
        bandar: orderData[4] || "",
        negeri: orderData[5] || "",
        produk: orderData[6] || "",
        saiz: orderData[7] || "",
        warna: orderData[8] || "",
        harga: orderData[9] || "",
        postage: orderData[10] || "",
        total: orderData[11] || "",
        kaedahBayar: orderData[12] || "",
        penamaakaun: orderData[13] || "",
        nota: orderData[14] || ""
      });
      jawapan = jawapan.split("ORDER_CONFIRMED:")[0].trim();
      if (!jawapan) {
        jawapan = "Terima kasih Cik! Order Cik telah berjaya direkodkan. Kami akan proses segera 😊";
      }
      followUpQueue[phoneNumber].stage = "paid";
      followUpQueue[phoneNumber].done = true;
      followUpQueue[phoneNumber].sent3a = true;
      followUpQueue[phoneNumber].sent3b = true;
    }

    // ===== DETECT SIZE CHART =====
    var kataSizeChart = ["size chart", "measurement", "carta saiz", "ukuran baju", "size guide"];
    var tanyaSizeChart = kataSizeChart.some(function(kata) {
      return text.toLowerCase().includes(kata);
    });

    if (tanyaSizeChart) {
      var fullHistory = sesi[phoneNumber].map(function(m) {
        return m.content;
      }).join(" ").toLowerCase();

      var bajuSizeChart = null;
      var lastIdxSC = -1;
      sizeChartImages.forEach(function(s) {
        var idx = fullHistory.lastIndexOf(s.Nama.toLowerCase());
        if (idx > lastIdxSC) {
          lastIdxSC = idx;
          bajuSizeChart = s;
        }
      });

      if (bajuSizeChart && bajuSizeChart.Gambar_URL) {
        await axios.post(
          "https://api.wassenger.com/v1/messages",
          {
            phone: phoneNumber,
            message: "Size chart " + bajuSizeChart.Nama + " untuk Cik 😊",
            media: { url: bajuSizeChart.Gambar_URL }
          },
          { headers: { Token: WASSENGER_TOKEN } }
        );
      } else {
        for (var sc = 0; sc < sizeChartImages.length; sc++) {
          if (sizeChartImages[sc].Gambar_URL) {
            await axios.post(
              "https://api.wassenger.com/v1/messages",
              {
                phone: phoneNumber,
                message: "Size chart " + sizeChartImages[sc].Nama + " 😊",
                media: { url: sizeChartImages[sc].Gambar_URL }
              },
              { headers: { Token: WASSENGER_TOKEN } }
            );
            await new Promise(function(resolve) { setTimeout(resolve, 1000); });
          }
        }
      }
      await hantarMesej(phoneNumber, jawapan);
      return res.sendStatus(200);
    }

    // ===== DETECT KATALOG / WARNA =====
    var kataKatalog = [
      "tengok gambar semua", "tunjuk semua design", "ada gambar tak",
      "boleh tunjuk koleksi", "tengok koleksi", "gambar semua",
      "nak tengok gambar", "nak tengok semua", "tunjuk gambar",
      "ada koleksi", "tengok semua", "show gambar", "gambar koleksi",
      "semua design", "semua baju", "koleksi baju",
      "ada design", "design apa", "baju apa ada"
    ];

    var tanyaKatalog = kataKatalog.some(function(kata) {
      return text.toLowerCase().includes(kata);
    });

    if (tanyaKatalog) {
      var historyText = sesi[phoneNumber].map(function(m) {
        return m.content;
      }).join(" ").toLowerCase();

      var bajuDlmHistory = null;
      var lastIdx = -1;
      var uniqueNama = [];
      products.forEach(function(p) {
        if (uniqueNama.indexOf(p.Nama) === -1) {
          uniqueNama.push(p.Nama);
        }
      });

      uniqueNama.forEach(function(nama) {
        var idx = historyText.lastIndexOf(nama.toLowerCase());
        if (idx > lastIdx) {
          lastIdx = idx;
          bajuDlmHistory = nama;
        }
      });

      if (bajuDlmHistory) {
        var warnaList = [];
        products.forEach(function(p) {
          if (p.Nama.toLowerCase() === bajuDlmHistory.toLowerCase() && p.Gambar_URL) {
            warnaList.push(p);
          }
        });

        for (var w = 0; w < warnaList.length; w++) {
          await axios.post(
            "https://api.wassenger.com/v1/messages",
            {
              phone: phoneNumber,
              message: warnaList[w].Warna,
              media: { url: warnaList[w].Gambar_URL }
            },
            { headers: { Token: WASSENGER_TOKEN } }
          );
          await new Promise(function(resolve) { setTimeout(resolve, 1000); });
        }
        await hantarMesej(phoneNumber, jawapan);
        return res.sendStatus(200);

      } else {
        var katalog = await getSheetDataCached("Katalog");
        for (var k = 0; k < katalog.length; k++) {
          if (katalog[k].Gambar_URL) {
            await axios.post(
              "https://api.wassenger.com/v1/messages",
              {
                phone: phoneNumber,
                message: katalog[k].Nama,
                media: { url: katalog[k].Gambar_URL }
              },
              { headers: { Token: WASSENGER_TOKEN } }
            );
            await new Promise(function(resolve) { setTimeout(resolve, 1000); });
          }
        }
        await hantarMesej(phoneNumber, "Ini semua koleksi terbaru ADEL Adyana Elegance 😊\n\nCik berminat dengan design yang mana?");
        return res.sendStatus(200);
      }
    }

    // ===== DETECT GAMBAR PRODUK =====
    var gambarUrl = null;
    products.forEach(function(p) {
      if (jawapan.toLowerCase().includes(p.Warna.toLowerCase()) &&
          jawapan.toLowerCase().includes(p.Nama.toLowerCase()) &&
          p.Gambar_URL) {
        gambarUrl = p.Gambar_URL;
      }
    });

    // Hantar mesej
    if (gambarUrl) {
      await axios.post(
        "https://api.wassenger.com/v1/messages",
        { phone: phoneNumber, message: jawapan, media: { url: gambarUrl } },
        { headers: { Token: WASSENGER_TOKEN } }
      );
    } else {
      await hantarMesej(phoneNumber, jawapan);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});