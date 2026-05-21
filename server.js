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
  } catch (err) {
    console.error("Error simpan order:", err);
  }
}

// ===== HANTAR MESEJ =====
async function hantarMesej(phoneNumber, mesej) {
  if (!mesej || !mesej.trim()) {
    console.error("Mesej kosong — skip hantar");
    return;
  }
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
      if (cuba < 3) await new Promise(function(r) { setTimeout(r, 2000); });
    }
  }
}

// ===== HANTAR GAMBAR =====
async function hantarGambar(phoneNumber, mesej, gambarUrl) {
  if (!mesej || !mesej.trim()) mesej = "😊";
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
      if (cuba < 3) await new Promise(function(r) { setTimeout(r, 2000); });
    }
  }
}

// ===== DAPATKAN BAJU TERAKHIR DALAM HISTORY =====
function getBajuTerakhir(history, products) {
  var historyLower = history.toLowerCase();
  var bajuTerakhir = null;
  var lastIdx = -1;
  var uniqueNama = [];
  products.forEach(function(p) {
    if (!p || !p.Nama) return;
    if (uniqueNama.indexOf(p.Nama) === -1) uniqueNama.push(p.Nama);
  });
  uniqueNama.forEach(function(nama) {
    var idx = historyLower.lastIndexOf(nama.toLowerCase());
    if (idx > lastIdx) { lastIdx = idx; bajuTerakhir = nama; }
  });
  return bajuTerakhir;
}

// ===== CLAUDE API CALL =====
async function callClaude(systemPrompt, messages, maxTokens) {
  var cuba = 0;
  while (cuba < 3) {
    try {
      var response = await claude.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens || 500,
        temperature: 0,
        system: systemPrompt,
        messages: messages
      });
      return response.content[0].text;
    } catch (err) {
      cuba++;
      if (cuba === 3) throw err;
      await new Promise(function(r) { setTimeout(r, 2000); });
    }
  }
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
      if (!q.sent1 && !q.hasJanji && (now - q.lastReply) >= 60 * 60 * 1000) {
        await hantarMesej(phone, MSG_STAGE1);
        followUpQueue[phone].sent1 = true;
        console.log("Stage 1 sent to " + phone);
      }
      if (q.hasJanji && !q.sent1b && q.janjiAt && (now - q.janjiAt) >= 3 * 60 * 60 * 1000) {
        try {
          var followUp1b = await callClaude(
            "Tulis follow up WhatsApp mesra Bahasa Malaysia. 2-3 ayat pendek. Panggil Cik. Jangan sebut harga. Teks biasa sahaja.",
            [{ role: "user", content: "Buyer kata: '" + q.lastContext + "'. Tulis follow up." }],
            150
          );
          await hantarMesej(phone, followUp1b);
          followUpQueue[phone].sent1b = true;
          followUpQueue[phone].sent1 = true;
          console.log("Stage 1b sent to " + phone);
        } catch (err) {
          console.error("Error stage 1b:", err.message);
        }
      }
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
      if (sheetName === "Sheet1" && !row.Nama) continue;
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
    if (!p || !p.Nama) return "";
    return p.Nama + " | Warna: " + p.Warna +
      " | Harga XS-2XL: RM" + p.Harga_XS_2XL +
      " | Harga 3XL-4XL: RM" + p.Harga_3XL_4XL + " (ADD ON RM10)" +
      " | Stok: XS=" + p.Stock_XS + " S=" + p.Stock_S +
      " M=" + p.Stock_M + " L=" + p.Stock_L +
      " XL=" + p.Stock_XL + " 2XL=" + p.Stock_2XL +
      " 3XL=" + p.Stock_3XL + " 4XL=" + p.Stock_4XL;
  }).filter(Boolean).join("\n");

  var sizeInfo = {};
  sizeChart.forEach(function(row) {
    if (!row.Ukuran) return;
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
    if (!p || !p.Nama) return;
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
    "- Untuk soalan tentang feature baju, rujuk DETAIL PRODUK sahaja\n" +
    "- Jika stok = 0: beritahu habis, cadang warna lain, kalau tak nak cadang baju lain\n" +
    "- Saiz 3XL dan 4XL ada tambahan RM10\n" +
    "- Kaedah Pembayaran: Bank Transfer atau COD\n" +
    "- COD: Tambah RM4 kepada kos postage\n" +
    "- Kadar Postage Semenanjung: 1pcs RM6, 2-5pcs RM4/pcs, 6pcs ke atas RM2/pcs\n" +
    "- Kadar Postage Sabah & Sarawak: 1pcs RM13, 2-5pcs RM8/pcs, 6pcs ke atas RM6/pcs\n" +
    "- Maklumat Akaun Bank: MAYBANK | Adel Adyana Elegance | 551100323485\n" +
    "- Selepas transfer, minta resit dan nama penama akaun bank\n" +
    "- Kamu BOLEH hantar gambar — sistem akan hantar automatik\n" +
    "- JANGAN kata tidak boleh hantar gambar atau tidak boleh tunjuk gambar\n" +
    "- LARANGAN MUTLAK: JANGAN tulis URL, link, markdown, bold dalam jawapan\n" +
    "- Flow order:\n" +
    "  1. Confirm beli → tanya lokasi (Semenanjung/Sabah/Sarawak)\n" +
    "  2. Kira postage → beritahu total\n" +
    "  3. Tanya kaedah bayar (Bank Transfer/COD)\n" +
    "  4. COD → tulis ORDER_COD_CONFIRMED\n" +
    "  4b. Resit bank transfer → tulis ORDER_RECEIPT_RECEIVED\n" +
    "  5. Minta details penghantaran\n" +
    "  6. Semua details lengkap → tulis: ORDER_CONFIRMED:nama|notel|alamat|poskod|bandar|negeri|produk|saiz|warna|harga|postage|total|kaedahbayar|penamaakaun|nota\n" +
    "- JANGAN minta details sebelum resit atau COD confirm\n" +
    "- Jika tanya size chart, jawab: Ini size chart untuk Cik 😊\n" +
    "- WAJIB: Setiap jawapan ada soalan susulan\n" +
    "- Jawapan teks biasa sahaja";
}

// ===== HEALTH CHECK =====
app.get("/", function(req, res) {
  res.send("Bot ADEL Adyana OK");
});

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

    // Voice message
    if (!text && isVoice) {
      await hantarMesej(phoneNumber, "Maaf Cik, saya tidak dapat dengar voice note. Boleh Cik taip mesej anda? 😊");
      return res.sendStatus(200);
    }

    // Media — resit kalau stage ordered
    if (!text && hasMedia) {
      if (followUpQueue[phoneNumber] && followUpQueue[phoneNumber].stage === "ordered") {
        followUpQueue[phoneNumber].stage = "paid";
        followUpQueue[phoneNumber].done = true;
        followUpQueue[phoneNumber].sent3a = true;
        followUpQueue[phoneNumber].sent3b = true;
        await hantarMesej(phoneNumber, "Terima kasih Cik! Resit dah kami terima. Boleh Cik berikan nama penuh dan alamat penghantaran? 😊");
      }
      return res.sendStatus(200);
    }

    if (!from || !text) return res.sendStatus(200);

    // Reset command
    if (text.trim() === "/reset") {
      sesi[phoneNumber] = [];
      await simpanSesi(phoneNumber, []);
      followUpQueue[phoneNumber] = {
        stage: "browsing", lastReply: Date.now(),
        sent1: false, sent1b: false, sent2: false,
        sent3a: false, sent3b: false, hasJanji: false,
        lastContext: "", janjiAt: null, orderedAt: null, done: false
      };
      await hantarMesej(phoneNumber, "Sesi telah direset. Boleh saya bantu Cik? 😊");
      return res.sendStatus(200);
    }

    // Prompt injection
    if (detectPromptInjection(text)) {
      await hantarMesej(phoneNumber, "Maaf Cik, saya hanya boleh membantu berkaitan produk ADEL Adyana Elegance. 😊");
      await hantarMesej("601123726341", "PROMPT INJECTION!\nNo: " + phoneNumber + "\nMesej: " + text);
      return res.sendStatus(200);
    }

    // Detect penukaran
    var katatukar = ["nak tukar", "nk tukar", "tukar alamat", "tukar baju",
      "tukar saiz", "tukar size", "tukar warna", "ubah alamat", "ubah baju",
      "ubah saiz", "ubah size", "ubah warna", "salah alamat", "salah saiz",
      "salah size", "salah baju", "salah warna", "boleh tukar", "boleh ubah",
      "cancel", "batalkan"];
    if (katatukar.some(function(k) { return text.toLowerCase().includes(k); })) {
      await hantarMesej("601123726341", "PERHATIAN - REQUEST PENUKARAN!\n\nNo Tel: " + phoneNumber + "\nMesej: " + text + "\n\nSila semak segera!");
    }

    // Setup follow up queue
    if (!followUpQueue[phoneNumber]) {
      followUpQueue[phoneNumber] = {
        stage: "browsing", lastReply: Date.now(),
        sent1: false, sent1b: false, sent2: false,
        sent3a: false, sent3b: false, hasJanji: false,
        lastContext: "", janjiAt: null, orderedAt: null, done: false
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
    }

    // Load sesi
    if (!sesi[phoneNumber]) {
      sesi[phoneNumber] = await loadSesi(phoneNumber);
    }
    sesi[phoneNumber].push({ role: "user", content: text });

    // Detect janji
    var kataJanji = ["kejap", "sat", "jap", "sekejap", "nanti", "later",
      "dengan anak", "dengan suami", "dengan isteri", "dengan husband",
      "dengan wife", "dengan family", "dengan mak", "dengan ayah",
      "balik rumah", "balik kerja", "petang", "malam", "esok", "insyaallah"];
    if (kataJanji.some(function(k) { return text.toLowerCase().includes(k); }) &&
        followUpQueue[phoneNumber].stage === "browsing") {
      followUpQueue[phoneNumber].hasJanji = true;
      followUpQueue[phoneNumber].lastContext = text;
      followUpQueue[phoneNumber].janjiAt = Date.now();
    }

    // Load data
    var products = await getSheetDataCached("Sheet1");
    var sizeChart = await getSheetDataCached("Size Chart");
    var produkDetail = await getSheetDataCached("produkDetail");
    var sizeChartImages = await getSheetDataCached("sizeChartImages");
    var katalog = await getSheetDataCached("Katalog");
    var systemPrompt = buatSystemPrompt(products, sizeChart, produkDetail);
    var textLower = text.toLowerCase();
    var history = sesi[phoneNumber].map(function(m) { return m.content; }).join(" ");

    // ===== 1. DETECT SIZE CHART =====
    var kataSizeChart = ["size chart", "measurement", "carta saiz", "ukuran baju",
      "size guide", "saiz chart", "chart size", "measurement chart",
      "tgk chart", "nk tgk size", "nak tgk size", "chart", "sizing"];
    if (kataSizeChart.some(function(k) { return textLower.includes(k); })) {
      var bajuSC = null;
      var lastIdxSC = -1;
      sizeChartImages.forEach(function(s) {
        if (!s || !s.Nama) return;
        var idx = history.toLowerCase().lastIndexOf(s.Nama.toLowerCase());
        if (idx > lastIdxSC) { lastIdxSC = idx; bajuSC = s; }
      });

      var scJawapan = await callClaude(systemPrompt, sesi[phoneNumber], 200);
      sesi[phoneNumber].push({ role: "assistant", content: scJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);

      if (bajuSC && bajuSC.Gambar_URL) {
        await hantarGambar(phoneNumber, "Size chart " + bajuSC.Nama + " untuk Cik 😊", bajuSC.Gambar_URL);
      } else {
        for (var sc = 0; sc < sizeChartImages.length; sc++) {
          if (sizeChartImages[sc] && sizeChartImages[sc].Gambar_URL) {
            await hantarGambar(phoneNumber, "Size chart " + sizeChartImages[sc].Nama + " 😊", sizeChartImages[sc].Gambar_URL);
            await new Promise(function(r) { setTimeout(r, 1000); });
          }
        }
      }
      await hantarMesej(phoneNumber, scJawapan);
      return res.sendStatus(200);
    }

    // ===== 2. DETECT SEMUA KATALOG =====
    var kataKatalog = ["tengok gambar semua", "tunjuk semua design",
      "boleh tunjuk koleksi", "tengok koleksi", "gambar semua",
      "nak tengok semua", "tengok semua", "semua design", "semua baju",
      "koleksi baju", "tunjuk semua warna", "semua warna", "semua gambar", "bagi gambar", "hantar gambar", "gambar koleksi",
  "gambar semua koleksi", "boleh bagi", "tunjuk semua"];
    if (kataKatalog.some(function(k) { return textLower.includes(k); })) {
      var bajuHistoryK = getBajuTerakhir(history, products);
      var katJawapan = await callClaude(systemPrompt, sesi[phoneNumber], 200);
      sesi[phoneNumber].push({ role: "assistant", content: katJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);

      if (bajuHistoryK) {
        var warnaListK = products.filter(function(p) {
          return p && p.Nama && p.Nama.toLowerCase() === bajuHistoryK.toLowerCase() && p.Gambar_URL;
        });
        for (var wk = 0; wk < warnaListK.length; wk++) {
          await hantarGambar(phoneNumber, warnaListK[wk].Warna, warnaListK[wk].Gambar_URL);
          await new Promise(function(r) { setTimeout(r, 1000); });
        }
      } else {
        for (var kat = 0; kat < katalog.length; kat++) {
          if (katalog[kat] && katalog[kat].Gambar_URL) {
            await hantarGambar(phoneNumber, katalog[kat].Nama, katalog[kat].Gambar_URL);
            await new Promise(function(r) { setTimeout(r, 1000); });
          }
        }
      }
      await hantarMesej(phoneNumber, katJawapan);
      return res.sendStatus(200);
    }

    // ===== 3. DETECT BAJU + WARNA SPECIFIC =====
    var bajuFound = null;
    var warnaFound = null;
    products.forEach(function(p) {
      if (!p || !p.Nama || !p.Warna) return;
      if (textLower.includes(p.Nama.toLowerCase()) && textLower.includes(p.Warna.toLowerCase())) {
        if (!bajuFound) { bajuFound = p.Nama; warnaFound = p.Warna; }
      }
    });

    if (bajuFound && warnaFound) {
      var produkSpesifik = products.find(function(p) {
        return p && p.Nama && p.Warna &&
          p.Nama.toLowerCase() === bajuFound.toLowerCase() &&
          p.Warna.toLowerCase() === warnaFound.toLowerCase() &&
          p.Gambar_URL;
      });
      var psJawapan = await callClaude(systemPrompt, sesi[phoneNumber], 300);
      sesi[phoneNumber].push({ role: "assistant", content: psJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);
      if (produkSpesifik) {
        await hantarGambar(phoneNumber, psJawapan, produkSpesifik.Gambar_URL);
      } else {
        await hantarMesej(phoneNumber, psJawapan);
      }
      return res.sendStatus(200);
    }

    // ===== 4. DETECT BAJU + TANYA WARNA =====
    var bajuDisebut = null;
    var uniqueNamaAll = [];
    products.forEach(function(p) {
      if (!p || !p.Nama) return;
      if (uniqueNamaAll.indexOf(p.Nama) === -1) uniqueNamaAll.push(p.Nama);
    });
    uniqueNamaAll.forEach(function(nama) {
      if (textLower.includes(nama.toLowerCase())) bajuDisebut = nama;
    });

    if (bajuDisebut && (textLower.includes("warna") || textLower.includes("color") ||
        textLower.includes("ada") || textLower.includes("contoh") || textLower.includes("gambar"))) {
      var warnaAvailable = products
        .filter(function(p) { return p && p.Nama && p.Nama.toLowerCase() === bajuDisebut.toLowerCase(); })
        .map(function(p) { return p.Warna; });

      var extraInfo = "Warna yang ada untuk " + bajuDisebut + ": " + warnaAvailable.join(", ") + ".";
      var twJawapan = await callClaude(systemPrompt + "\n\nMAKLUMAT: " + extraInfo, sesi[phoneNumber], 300);
      sesi[phoneNumber].push({ role: "assistant", content: twJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);
      await hantarMesej(phoneNumber, twJawapan);

      // Hantar gambar katalog baju tu
      var katalogBaju = katalog.find(function(k) {
        return k && k.Nama && (k.Nama.toLowerCase().includes(bajuDisebut.toLowerCase()) ||
          bajuDisebut.toLowerCase().includes(k.Nama.toLowerCase()));
      });
      if (katalogBaju && katalogBaju.Gambar_URL) {
        await new Promise(function(r) { setTimeout(r, 1000); });
        await hantarGambar(phoneNumber, katalogBaju.Nama, katalogBaju.Gambar_URL);
      }
      return res.sendStatus(200);
    }

    // ===== 5. PROSES NORMAL =====
    var jawapan = await callClaude(systemPrompt, sesi[phoneNumber], 500);

    // Detect COD
    if (jawapan.includes("ORDER_COD_CONFIRMED")) {
      followUpQueue[phoneNumber].stage = "ordered";
      followUpQueue[phoneNumber].orderedAt = Date.now();
      followUpQueue[phoneNumber].sent3a = false;
      followUpQueue[phoneNumber].sent3b = false;
      followUpQueue[phoneNumber].done = false;
      jawapan = jawapan.replace("ORDER_COD_CONFIRMED", "").trim();
    }

    // Detect resit
    if (jawapan.includes("ORDER_RECEIPT_RECEIVED")) {
      followUpQueue[phoneNumber].stage = "paid";
      followUpQueue[phoneNumber].done = true;
      jawapan = jawapan.replace("ORDER_RECEIPT_RECEIVED", "").trim();
    }

    // Detect order confirmed
    if (jawapan.includes("ORDER_CONFIRMED:")) {
      var orderData = jawapan.split("ORDER_CONFIRMED:")[1].split("|");
      await simpanOrder({
        nama: orderData[0] || "", noTel: orderData[1] || "",
        alamat: orderData[2] || "", poskod: orderData[3] || "",
        bandar: orderData[4] || "", negeri: orderData[5] || "",
        produk: orderData[6] || "", saiz: orderData[7] || "",
        warna: orderData[8] || "", harga: orderData[9] || "",
        postage: orderData[10] || "", total: orderData[11] || "",
        kaedahBayar: orderData[12] || "", penamaakaun: orderData[13] || "",
        nota: orderData[14] || ""
      });
      jawapan = jawapan.split("ORDER_CONFIRMED:")[0].trim();
      if (!jawapan) jawapan = "Terima kasih Cik! Order Cik telah berjaya direkodkan. Kami akan proses segera 😊";
      followUpQueue[phoneNumber].stage = "paid";
      followUpQueue[phoneNumber].done = true;
      followUpQueue[phoneNumber].sent3a = true;
      followUpQueue[phoneNumber].sent3b = true;
    }

    sesi[phoneNumber].push({ role: "assistant", content: jawapan });
    await simpanSesi(phoneNumber, sesi[phoneNumber]);

    // Auto detect gambar dari jawapan Claude (hanya kalau buyer tanya gambar/warna)
    var kataGambarAuto = ["gambar", "warna", "contoh", "tunjuk", "tengok", "tgk", "colour", "color", "lihat"];
    var buyerTanyaGambar = kataGambarAuto.some(function(k) { return textLower.includes(k); });
    var autoGambarUrl = null;

    if (buyerTanyaGambar) {
      var bajuTerakhir = getBajuTerakhir(history, products);
      if (bajuTerakhir) {
        products.forEach(function(p) {
          if (!p || !p.Nama || !p.Warna || !p.Gambar_URL) return;
          if (p.Nama.toLowerCase() === bajuTerakhir.toLowerCase() &&
              jawapan.toLowerCase().includes(p.Warna.toLowerCase())) {
            autoGambarUrl = p.Gambar_URL;
          }
        });
      }
    }

    // Detect bot senarai warna — hantar gambar katalog
    var adaSenaraWarna = jawapan.toLowerCase().includes("warna yang ada") ||
      jawapan.toLowerCase().includes("warna yang tersedia") ||
      jawapan.toLowerCase().includes("pilihan warna");

    if (adaSenaraWarna) {
      var bajuSenarai = getBajuTerakhir(history + " " + jawapan, products);
      await hantarMesej(phoneNumber, jawapan);
      if (bajuSenarai) {
        var warnaListSenarai = products.filter(function(p) {
          return p && p.Nama && p.Nama.toLowerCase() === bajuSenarai.toLowerCase() && p.Gambar_URL;
        });
        await new Promise(function(r) { setTimeout(r, 1000); });
        for (var ws = 0; ws < warnaListSenarai.length; ws++) {
          await hantarGambar(phoneNumber, warnaListSenarai[ws].Warna, warnaListSenarai[ws].Gambar_URL);
          await new Promise(function(r) { setTimeout(r, 1000); });
        }
      }
      return res.sendStatus(200);
    }

    if (autoGambarUrl) {
      await hantarGambar(phoneNumber, jawapan, autoGambarUrl);
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