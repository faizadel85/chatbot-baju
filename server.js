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

// ===== HANTAR GAMBAR =====
async function hantarGambar(phoneNumber, mesej, gambarUrl) {
  var cuba = 0;
  while (cuba < 3) {
    try {
      await axios.post(
        "https://api.wassenger.com/v1/messages",
        { phone: phoneNumber, message: mesej, media: { url: gambarUrl } },
        { headers: { Token: WASSENGER_TOKEN } }
      );
      return;
    } catch (err) {
      cuba++;
      console.error("Error hantar gambar cuba " + cuba + ":", err.message);
      if (cuba < 3) {
        await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      }
    }
  }
}

// ===== DETECT GAMBAR DARI TEXT =====
// Ini adalah fungsi utama yang detect gambar berdasarkan keyword dalam text buyer
// Tidak bergantung pada Claude untuk decide gambar
function detectGambarDariText(text, products, sizeChartImages) {
  var textLower = text.toLowerCase();
  var result = { type: null, data: null };

  // 1. Check size chart keywords
  var kataSizeChart = [
    "size chart", "measurement", "carta saiz", "ukuran baju", "size guide",
    "saiz chart", "chart size", "ukuran", "measurement chart",
    "boleh tgk size", "tunjuk size", "tgk chart", "nk tgk size",
    "nak tgk size", "chart", "sizing"
  ];
  var tanyaSizeChart = kataSizeChart.some(function(kata) {
    return textLower.includes(kata);
  });
  if (tanyaSizeChart) {
    result.type = "sizechart";
    return result;
  }

  // 2. Check katalog/semua warna keywords
  var kataKatalog = [
    "tengok gambar semua", "tunjuk semua design", "ada gambar tak",
    "boleh tunjuk koleksi", "tengok koleksi", "gambar semua",
    "nak tengok gambar", "nak tengok semua", "tunjuk gambar",
    "ada koleksi", "tengok semua", "show gambar", "gambar koleksi",
    "semua design", "semua baju", "koleksi baju",
    "ada design", "design apa", "baju apa ada", "semua warna",
    "tunjuk semua warna", "warna apa ada", "ada warna apa",
    "warna yang ada", "pilihan warna", "warna lain", "contoh", "ada contoh", "tgk contoh", "tengok contoh",
    "gambar tak", "ada gambar", "tunjuk", "nak tengok", "nsk tengok", "nk tengok", "nk tgk", "nak tgk",
    "nk tengok warna", "tgk warna", "tengok warna",
    "nak tengok warna", "nk tgk warna", "warna apa", "tengok warna", "tgk warna",
    "warna yang ada", "pilihan warna", "warna lain", "warna ni"
  ];
  var tanyaKatalog = kataKatalog.some(function(kata) {
    return textLower.includes(kata);
  });
  if (tanyaKatalog) {
    result.type = "katalog";
    return result;
  }

  // 3. Check specific warna disebutkan
  var warnaFound = null;
  var bajuFound = null;

  products.forEach(function(p) {
    if (textLower.includes(p.Nama.toLowerCase()) && textLower.includes(p.Warna.toLowerCase())) {
      if (!bajuFound) {
        bajuFound = p.Nama;
        warnaFound = p.Warna;
      }
    }
  });

  if (bajuFound && warnaFound) {
    result.type = "produk_spesifik";
    result.data = { nama: bajuFound, warna: warnaFound };
    return result;
  }

  // 4. Check kalau sebut warna sahaja (tanpa nama baju)
  var warnaList = ["navy blue", "black", "dark brown", "denim blue", "matcha green",
    "nudebrown", "nude brown", "white", "cream", "maroon", "grey", "pink",
    "purple", "red", "blue", "green", "brown", "beige", "olive"];

  warnaList.forEach(function(warna) {
    if (textLower.includes(warna) && !warnaFound) {
      warnaFound = warna;
    }
  });

  if (warnaFound) {
    result.type = "warna_sahaja";
    result.data = { warna: warnaFound };
    return result;
  }

  return result;
}

// ===== STAGE FOLLOW UP =====
var followUpQueue = {};

var MSG_STAGE1 = "Assalamualaikum 🫶🏻 Cik cari size dan warna apa ya?\n\nAtau nak saya bantu dapatkan size yg sesuai untuk Cik?";
var MSG_STAGE2 = "Assalamualaikum! Semoga Cik dalam keadaan baik & semoga urusan kita sama² dipermudahkan hari ini 😊\n\nCik ada tekan link iklan saya dari FB/IG. Saya sangat-sangat hargai respon Cik 💕\n\nCik tengah cari warna dan size apa ya? Ada apa boleh saya bantu?";
var MSG_STAGE3A = "Salam Cik 😊\n\nSaya nak follow-up order Cik tadi ya. Untuk proceed packing, boleh send resit payment bila sempat 🙏\n\nStock design ni tengah laju keluar hari ni 😊";
var MSG_STAGE3B = "Salam Cik 🌷\n\nOrder Cik masih available ya buat masa sekarang 😊\n\nBila payment dah settle nanti boleh terus send resit dekat saya supaya team boleh reserve & packing cepat ❤️";

setInterval(async function() {
  var now = Date.now();
  for (var phone in followUpQueue) {
    var q = followUpQueue[phone];
    if (q.done) continue;

    if (q.stage === "browsing") {
      // Stage 1 — hanya hantar kalau TIADA janji
      if (!q.sent1 && !q.hasJanji && (now - q.lastReply) >= 60 * 60 * 1000) {
        await hantarMesej(phone, MSG_STAGE1);
        followUpQueue[phone].sent1 = true;
        console.log("Stage 1 sent to " + phone);
      }

      // Stage 1b — hanya hantar kalau ADA janji, 3 jam selepas janji
      if (q.hasJanji && !q.sent1b && q.janjiAt && (now - q.janjiAt) >= 3 * 60 * 60 * 1000) {
        try {
          var contextResponse = await claude.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 150,
            temperature: 0,
            messages: [{
              role: "user",
              content: "Tulis follow up WhatsApp yang mesra dalam Bahasa Malaysia. Buyer sebelum ni kata: '" + q.lastContext + "'. Tulis 2-3 ayat pendek, panggil Cik, jangan sebut harga, tanya kalau dah boleh proceed. Teks biasa sahaja tanpa emoji berlebihan."
            }]
          });
          var followUp1b = contextResponse.content[0].text;
          await hantarMesej(phone, followUp1b);
          followUpQueue[phone].sent1b = true;
          followUpQueue[phone].sent1 = true;
          console.log("Stage 1b sent to " + phone);
        } catch (err) {
          console.error("Error stage 1b:", err.message);
        }
      }

      // Stage 2 — 24 jam
      if (q.sent1 && !q.sent2 && (now - q.lastReply) >= 24 * 60 * 60 * 1000) {
        await hantarMesej(phone, MSG_STAGE2);
        followUpQueue[phone].sent2 = true;
        followUpQueue[phone].done = true;
        console.log("Stage 2 sent to " + phone);
      }
    }

    if (q.stage === "ordered") {
      if (!q.sent3a && q.orderedAt && (now - q.orderedAt) >= 3 * 60 * 60 * 1000) {
        await hantarMesej(phone, MSG_STAGE3A);
        followUpQueue[phone].sent3a = true;
        console.log("Stage 3a sent to " + phone);
      }
      if (q.sent3a && !q.sent3b && q.orderedAt && (now - q.orderedAt) >= 24 * 60 * 60 * 1000) {
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
function buatSystemPrompt(products, sizeChart, produkDetail) {
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

  return "Kamu adalah pembantu jualan kedai baju ADEL Adyana Elegance. Jawab dalam Bahasa Malaysia Baku yang ringkas, mesra dan profesional.\n" +
    "PENTING: Panggil pelanggan sebagai Cik sahaja.\n" +
    "BAHASA: Gunakan HANYA Bahasa Malaysia. DILARANG guna perkataan Indonesia seperti cocok, oke, yuk, dong, sih, deh, banget.\n" +
    "GAYA: Ayat pendek, mudah faham, profesional. Maksimum 3-4 ayat per jawapan.\n\n" +
    "PRODUK:\n" + senaraiProduk + "\n\n" +
    "PANDUAN SAIZ:\n" + sizeText + "\n\n" +
    "DETAIL PRODUK:\n" + detailText + "\n\n" +
    "PERATURAN:\n" +
    "- Harga HANYA sebut bila pelanggan tanya atau dah setuju nak beli\n" +
    "- Bila pelanggan tanya warna — senaraikan warna yang ada SAHAJA dalam teks\n" +
    "- Tanya berat badan (kg) dan ukuran dada (INCHI) untuk recommend saiz\n" +
    "- Semua ukuran dalam INCHI bukan cm\n" +
    "- Untuk soalan tentang feature baju, rujuk DETAIL PRODUK — jawab berdasarkan maklumat tu sahaja\n" +
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
    "  6. Bila pelanggan pilih COD, tulis ORDER_COD_CONFIRMED dalam jawapan\n" +
    "  6b. Bila pelanggan hantar resit Bank Transfer, tulis ORDER_RECEIPT_RECEIVED dalam jawapan\n" +
    "  7. Minta details penghantaran (nama, no telefon, alamat, poskod, bandar, negeri)\n" +
    "  8. Bila semua details lengkap, tulis: ORDER_CONFIRMED:nama|notel|alamat|poskod|bandar|negeri|produk|saiz|warna|harga|postage|total|kaedahbayar|penamaakaun|nota\n" +
    "- JANGAN minta details penghantaran sebelum pelanggan hantar resit atau confirm COD\n" +
    "- Bila pelanggan bagi details penghantaran, JANGAN tanya semula produk\n" +
    "- Jika pelanggan tanya size chart, jawab HANYA: Ini size chart untuk Cik 😊\n" +
    "- WAJIB: Setiap jawapan mesti ada soalan susulan\n" +
    "- JANGAN guna markdown atau asterisk dalam jawapan\n" +
    "- Jawapan mesti dalam teks biasa sahaja";
}

// ===== WEBHOOK =====
app.post("/webhook", async function(req, res) {
  try {
    var data = req.body;

    if (data.event !== "message:in:new") return res.sendStatus(200);
    if (data.data.fromMe) return res.sendStatus(200);

    var from = data.data.chatId || data.data.from ||
      (data.data.chat && data.data.chat.id) ||
      (data.data.contact && data.data.contact.wid) || "";
    var text = data.data.body || data.data.text ||
      data.data.caption || data.data.message || "";
    var hasMedia = data.data.hasMedia || data.data.type === "image" || data.data.type === "document";
    var isVoice = data.data.type === "audio" || data.data.type === "ptt";
    var phoneNumber = from.replace("@c.us", "").replace("@s.whatsapp.net", "").replace("@lid", "");

    if (!phoneNumber) return res.sendStatus(200);

    // Detect voice message
    if (!text && isVoice) {
      await hantarMesej(phoneNumber, "Maaf Cik, saya tidak dapat dengar voice note. Boleh Cik taip mesej anda? 😊");
      return res.sendStatus(200);
    }

    // Detect media/gambar — anggap sebagai resit kalau stage ordered
    if (!text && hasMedia) {
      if (followUpQueue[phoneNumber] && followUpQueue[phoneNumber].stage === "ordered") {
        followUpQueue[phoneNumber].stage = "paid";
        followUpQueue[phoneNumber].done = true;
        followUpQueue[phoneNumber].sent3a = true;
        followUpQueue[phoneNumber].sent3b = true;
        console.log("Resit diterima dari: " + phoneNumber);
        await hantarMesej(phoneNumber, "Terima kasih Cik! Resit dah kami terima. Boleh Cik berikan nama penuh dan alamat penghantaran? 😊");
      }
      return res.sendStatus(200);
    }

    if (!from || !text) return res.sendStatus(200);

    // Check prompt injection
    if (detectPromptInjection(text)) {
      console.log("Prompt injection dari: " + phoneNumber);
      await hantarMesej(phoneNumber, "Maaf Cik, saya hanya boleh membantu berkaitan produk dan pesanan ADEL Adyana Elegance sahaja. 😊");
      await hantarMesej("601123726341", "PROMPT INJECTION!\nNo: " + phoneNumber + "\nMesej: " + text);
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
      await hantarMesej("601123726341", "PERHATIAN - REQUEST PENUKARAN!\n\nNo Tel: " + phoneNumber + "\nMesej: " + text + "\n\nSila semak segera!");
    }

    // Setup follow up queue
    if (!followUpQueue[phoneNumber]) {
      followUpQueue[phoneNumber] = {
        stage: "browsing",
        lastReply: Date.now(),
        sent1: false,
        sent1b: false,
        sent2: false,
        sent3a: false,
        sent3b: false,
        hasJanji: false,
        lastContext: "",
        janjiAt: null,
        orderedAt: null,
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
      }
      // stage "paid" — jangan buat apa-apa
    }

    // Load sesi
    if (!sesi[phoneNumber]) {
      sesi[phoneNumber] = await loadSesi(phoneNumber);
    }
    sesi[phoneNumber].push({ role: "user", content: text });

    // Detect janji dari buyer
    var kataJanji = [
      "kejap", "sat", "jap", "sekejap", "nanti", "later",
      "tanya", "confirm", "check", "tengok dulu", "fikir dulu",
      "dengan anak", "dengan suami", "dengan isteri", "dengan husband",
      "dengan wife", "dengan family", "dengan mak", "dengan ayah",
      "balik rumah", "balik kerja", "petang", "malam", "esok",
      "insyaallah", "ok nanti"
    ];
    var adaJanji = kataJanji.some(function(kata) {
      return text.toLowerCase().includes(kata);
    });
    if (adaJanji && followUpQueue[phoneNumber].stage === "browsing") {
      followUpQueue[phoneNumber].hasJanji = true;
      followUpQueue[phoneNumber].lastContext = text;
      followUpQueue[phoneNumber].janjiAt = Date.now();
      console.log("Buyer bagi janji: " + phoneNumber);
    }

    // Load data
    var products = await getSheetDataCached("Sheet1");
    var sizeChart = await getSheetDataCached("Size Chart");
    var produkDetail = await getSheetDataCached("produkDetail");
    var sizeChartImages = await getSheetDataCached("sizeChartImages");
    var katalog = await getSheetDataCached("Katalog");
    var systemPrompt = buatSystemPrompt(products, sizeChart, produkDetail);

    // ===== DETECT GAMBAR DARI TEXT BUYER (CODE-BASED) =====
    var gambarDetect = detectGambarDariText(text, products, sizeChartImages);

   // Check kalau buyer tanya warna specific yang mungkin takde
   if (gambarDetect.type === null) {
     var uniqueNamaCheck = [];
     products.forEach(function(p) {
       if (uniqueNamaCheck.indexOf(p.Nama) === -1) uniqueNamaCheck.push(p.Nama);
     });
  
     var bajuDisebut2 = null;
     uniqueNamaCheck.forEach(function(nama) {
       if (text.toLowerCase().includes(nama.toLowerCase())) {
        bajuDisebut2 = nama;
       }
     });

     if (bajuDisebut2 && (text.toLowerCase().includes("warna") || 
         text.toLowerCase().includes("color") || 
         text.toLowerCase().includes("colour") ||
         text.toLowerCase().includes("ada") )) {
       gambarDetect.type = "tanya_warna_specific";
       gambarDetect.data = { nama: bajuDisebut2 };
     }
   }

    if (gambarDetect.type === "sizechart") {
      // Hantar size chart berdasarkan baju dalam history
      var fullHistory = sesi[phoneNumber].map(function(m) { return m.content; }).join(" ").toLowerCase();
      var bajuSC = null;
      var lastIdxSC = -1;
      sizeChartImages.forEach(function(s) {
        var idx = fullHistory.lastIndexOf(s.Nama.toLowerCase());
        if (idx > lastIdxSC) { lastIdxSC = idx; bajuSC = s; }
      });

      // Dapatkan jawapan Claude dulu
      var scResponse = await claude.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        temperature: 0,
        system: systemPrompt,
        messages: sesi[phoneNumber]
      });
      var scJawapan = scResponse.content[0].text;
      sesi[phoneNumber].push({ role: "assistant", content: scJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);

      if (bajuSC && bajuSC.Gambar_URL) {
        await hantarGambar(phoneNumber, "Size chart " + bajuSC.Nama + " untuk Cik 😊", bajuSC.Gambar_URL);
      } else {
        for (var sc = 0; sc < sizeChartImages.length; sc++) {
          if (sizeChartImages[sc].Gambar_URL) {
            await hantarGambar(phoneNumber, "Size chart " + sizeChartImages[sc].Nama + " 😊", sizeChartImages[sc].Gambar_URL);
            await new Promise(function(resolve) { setTimeout(resolve, 1000); });
          }
        }
      }
      await hantarMesej(phoneNumber, scJawapan);
      return res.sendStatus(200);
    }

    if (gambarDetect.type === "katalog") {
      // Semak baju dalam history
      var historyForKatalog = sesi[phoneNumber].map(function(m) { return m.content; }).join(" ").toLowerCase();
      var bajuHistory = null;
      var lastIdxK = -1;
      var uniqueNamaK = [];
      products.forEach(function(p) {
        if (uniqueNamaK.indexOf(p.Nama) === -1) uniqueNamaK.push(p.Nama);
      });
      uniqueNamaK.forEach(function(nama) {
        var idx = historyForKatalog.lastIndexOf(nama.toLowerCase());
        if (idx > lastIdxK) { lastIdxK = idx; bajuHistory = nama; }
      });

      // Dapatkan jawapan Claude
      var katResponse = await claude.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 200,
        temperature: 0,
        system: systemPrompt,
        messages: sesi[phoneNumber]
      });
      var katJawapan = katResponse.content[0].text;
      sesi[phoneNumber].push({ role: "assistant", content: katJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);

      if (bajuHistory) {
        var warnaListK = [];
        products.forEach(function(p) {
          if (p.Nama.toLowerCase() === bajuHistory.toLowerCase() && p.Gambar_URL) {
            warnaListK.push(p);
          }
        });
        for (var wk = 0; wk < warnaListK.length; wk++) {
          await hantarGambar(phoneNumber, warnaListK[wk].Warna, warnaListK[wk].Gambar_URL);
          await new Promise(function(resolve) { setTimeout(resolve, 1000); });
        }
        await hantarMesej(phoneNumber, katJawapan);
      } else {
        for (var kat = 0; kat < katalog.length; kat++) {
          if (katalog[kat].Gambar_URL) {
            await hantarGambar(phoneNumber, katalog[kat].Nama, katalog[kat].Gambar_URL);
            await new Promise(function(resolve) { setTimeout(resolve, 1000); });
          }
        }
        await hantarMesej(phoneNumber, "Ini semua koleksi terbaru ADEL Adyana Elegance 😊\n\nCik berminat dengan design yang mana?");
      }
      return res.sendStatus(200);
    }

    if (gambarDetect.type === "produk_spesifik") {
      // Hantar gambar warna specific yang disebut
      var produkSpesifik = null;
      products.forEach(function(p) {
        if (p.Nama.toLowerCase() === gambarDetect.data.nama.toLowerCase() &&
            p.Warna.toLowerCase() === gambarDetect.data.warna.toLowerCase() &&
            p.Gambar_URL) {
          produkSpesifik = p;
        }
      });

      var psResponse = await claude.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        temperature: 0,
        system: systemPrompt,
        messages: sesi[phoneNumber]
      });
      var psJawapan = psResponse.content[0].text;
      sesi[phoneNumber].push({ role: "assistant", content: psJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);

      if (produkSpesifik) {
        await hantarGambar(phoneNumber, psJawapan, produkSpesifik.Gambar_URL);
      } else {
        await hantarMesej(phoneNumber, psJawapan);
      }
      return res.sendStatus(200);
    }

    if (gambarDetect.type === "warna_sahaja") {
    if (gambarDetect.type === "tanya_warna_specific") {
     var bajuTanya = gambarDetect.data.nama;
  
     // Semak warna yang disebut buyer ada dalam sheet tak
     var warnaAvailable = [];
     products.forEach(function(p) {
       if (p.Nama.toLowerCase() === bajuTanya.toLowerCase()) {
        warnaAvailable.push(p.Warna);
       }
     });

    // Tambah info warna available dalam system prompt untuk Claude jawab
    var extraInstruction = "Pelanggan tanya warna untuk " + bajuTanya + ". Warna yang ada: " + warnaAvailable.join(", ") + ". Kalau warna yang ditanya takde, beritahu dengan mesra dan cadang warna yang ada.";
  
    var twResponse = await claude.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      temperature: 0,
      system: systemPrompt + "\n\nMAKLUMAT TAMBAHAN: " + extraInstruction,
      messages: sesi[phoneNumber]
    });
    var twJawapan = twResponse.content[0].text;
    sesi[phoneNumber].push({ role: "assistant", content: twJawapan });
    await simpanSesi(phoneNumber, sesi[phoneNumber]);
    await hantarMesej(phoneNumber, twJawapan);
    return res.sendStatus(200);
  }

      // Semak baju dari history, hantar gambar warna tersebut
      var historyForWarna = sesi[phoneNumber].map(function(m) { return m.content; }).join(" ").toLowerCase();
      var bajuForWarna = null;
      var lastIdxWarna = -1;
      var uniqueNamaWarna = [];
      products.forEach(function(p) {
        if (uniqueNamaWarna.indexOf(p.Nama) === -1) uniqueNamaWarna.push(p.Nama);
      });
      uniqueNamaWarna.forEach(function(nama) {
        var idx = historyForWarna.lastIndexOf(nama.toLowerCase());
        if (idx > lastIdxWarna) { lastIdxWarna = idx; bajuForWarna = nama; }
      });

      var wsResponse = await claude.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        temperature: 0,
        system: systemPrompt,
        messages: sesi[phoneNumber]
      });
      var wsJawapan = wsResponse.content[0].text;
      sesi[phoneNumber].push({ role: "assistant", content: wsJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);

      var produkWarna = null;
      if (bajuForWarna) {
        products.forEach(function(p) {
          if (p.Nama.toLowerCase() === bajuForWarna.toLowerCase() &&
              p.Warna.toLowerCase().includes(gambarDetect.data.warna.toLowerCase()) &&
              p.Gambar_URL) {
            produkWarna = p;
          }
        });
      }

      if (produkWarna) {
        await hantarGambar(phoneNumber, wsJawapan, produkWarna.Gambar_URL);
      } else {
        await hantarMesej(phoneNumber, wsJawapan);
      }
      return res.sendStatus(200);
    }

    // ===== PROSES NORMAL — TIADA GAMBAR DETECTED =====
    var response;
    var cuba = 0;
    while (cuba < 3) {
      try {
        response = await claude.messages.create({
          model: "claude-haiku-4-5",
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
   // Detect kalau bot senarai warna — terus hantar semua gambar warna
   var adaSenaraWarna = jawapan.toLowerCase().includes("warna yang ada") || 
                        jawapan.toLowerCase().includes("warna yang tersedia") ||
                        jawapan.toLowerCase().includes("warna yang kami ada") ||
                        jawapan.toLowerCase().includes("pilihan warna");

   if (adaSenaraWarna) {
     sesi[phoneNumber].push({ role: "assistant", content: jawapan });
     await simpanSesi(phoneNumber, sesi[phoneNumber]);
  
    // Cari baju dalam history
    var historyWarnaSenarai = sesi[phoneNumber].map(function(m) { return m.content; }).join(" ").toLowerCase();
    var bajuWarnaSenarai = null;
    var lastIdxWS = -1;
    var uniqueNamaWS = [];
    products.forEach(function(p) {
      if (uniqueNamaWS.indexOf(p.Nama) === -1) uniqueNamaWS.push(p.Nama);
    });
    uniqueNamaWS.forEach(function(nama) {
      var idx = historyWarnaSenarai.lastIndexOf(nama.toLowerCase());
      if (idx > lastIdxWS) { lastIdxWS = idx; bajuWarnaSenarai = nama; }
    });

    await hantarMesej(phoneNumber, jawapan);
  
    if (bajuWarnaSenarai) {
      var warnaListSenarai = [];
      products.forEach(function(p) {
        if (p.Nama.toLowerCase() === bajuWarnaSenarai.toLowerCase() && p.Gambar_URL) {
          warnaListSenarai.push(p);
        }
      });
      await new Promise(function(resolve) { setTimeout(resolve, 1000); });
      for (var ws = 0; ws < warnaListSenarai.length; ws++) {
        await hantarGambar(phoneNumber, warnaListSenarai[ws].Warna, warnaListSenarai[ws].Gambar_URL);
        await new Promise(function(resolve) { setTimeout(resolve, 1000); });
      }
    }
    return res.sendStatus(200);
  }
    await simpanSesi(phoneNumber, sesi[phoneNumber]);

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

    await hantarMesej(phoneNumber, twJawapan);

    // Hantar gambar katalog baju yang ditanya
    var katalogBaju = null;
    katalog.forEach(function(k) {
      if (k.Nama.toLowerCase().includes(bajuTanya.toLowerCase()) ||
          bajuTanya.toLowerCase().includes(k.Nama.toLowerCase())) {
        katalogBaju = k;
      }
    });

    if (katalogBaju && katalogBaju.Gambar_URL) {
      await new Promise(function(resolve) { setTimeout(resolve, 1000); });
      await hantarGambar(phoneNumber, katalogBaju.Nama, katalogBaju.Gambar_URL);
    }
    return res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});