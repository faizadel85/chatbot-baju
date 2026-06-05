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

function detectPromptInjection(text) {
  var attacks = ["ignore previous","ignore above","ignore all","forget previous","forget instructions","forget all","new instructions","new rules","override instructions","system prompt","reveal prompt","show prompt","pretend you are","act as","you are now","jailbreak","dan mode","developer mode","ignore your training","bypass","disregard","abaikan arahan","tukar peranan","jadi ai lain","tunjuk prompt","dedahkan sistem","lupakan arahan","abaikan semua","arahan baru","peranan baru"];
  var textLower = text.toLowerCase();
  return attacks.some(function(attack) { return textLower.includes(attack); });
}

async function getGoogleAuth() {
  var credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  var auth = new google.auth.GoogleAuth({ credentials: credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return auth;
}

var sheetCache = {};
var CACHE_DURATION = 1 * 60 * 1000;

async function getSheetDataCached(sheetName) {
  var now = Date.now();
  if (sheetCache[sheetName] && (now - sheetCache[sheetName].time) < CACHE_DURATION) return sheetCache[sheetName].data;
  var data = await getSheetData(sheetName);
  sheetCache[sheetName] = { data: data, time: now };
  return data;
}

async function simpanSesi(phoneNumber, messages) {
  try {
    var auth = await getGoogleAuth();
    var sheets = google.sheets({ version: "v4", auth });
    var result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Sessions!A:A" });
    var rows = result.data.values || [];
    var rowIndex = -1;
    for (var i = 0; i < rows.length; i++) { if (rows[i][0] === phoneNumber) { rowIndex = i + 1; break; } }
    var now = new Date().toISOString();
    var messagesJson = JSON.stringify(messages.slice(-20));
    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: "Sessions!A" + rowIndex + ":C" + rowIndex, valueInputOption: "RAW", resource: { values: [[phoneNumber, now, messagesJson]] } });
    } else {
      await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: "Sessions!A:C", valueInputOption: "RAW", resource: { values: [[phoneNumber, now, messagesJson]] } });
    }
  } catch (err) { console.error("Error simpan sesi:", err); }
}

async function loadSesi(phoneNumber) {
  try {
    var auth = await getGoogleAuth();
    var sheets = google.sheets({ version: "v4", auth });
    var result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Sessions!A:C" });
    var rows = result.data.values || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === phoneNumber) {
        var messages = JSON.parse(rows[i][2] || "[]");
        var lastUpdated = new Date(rows[i][1]);
        var now = new Date();
        if ((now - lastUpdated) / (1000 * 60 * 60) > 168) return [];
        return messages;
      }
    }
    return [];
  } catch (err) { console.error("Error load sesi:", err); return []; }
}

async function simpanOrder(data) {
  try {
    var auth = await getGoogleAuth();
    var sheets = google.sheets({ version: "v4", auth });
    var tarikh = new Date().toLocaleString("ms-MY", { timeZone: "Asia/Kuala_Lumpur" });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: "Orders!A:O", valueInputOption: "RAW",
      resource: { values: [[tarikh, data.nama||"", data.noTel||"", data.alamat||"", data.poskod||"", data.bandar||"", data.negeri||"", data.produk||"", data.saiz||"", data.warna||"", data.harga||"", (data.kaedahBayar||"") + (data.penamaakaun ? " | " + data.penamaakaun : ""), "Baru"]] }
    });
    console.log("Order disimpan!");
    var notifMsg = "ORDER BARU!\n\nNama: "+(data.nama||"")+"\nNo Tel: "+(data.noTel||"")+"\nProduk: "+(data.produk||"")+"\nWarna: "+(data.warna||"")+"\nSaiz: "+(data.saiz||"")+"\nHarga: RM"+(data.harga||"")+"\nPostage: RM"+(data.postage||"")+"\nTotal: RM"+(data.total||"")+"\n\nAlamat: "+(data.alamat||"")+"\nPoskod: "+(data.poskod||"")+"\nBandar: "+(data.bandar||"")+"\nNegeri: "+(data.negeri||"")+"\n\nKaedah Bayar: "+(data.kaedahBayar||"")+"\nPenama Akaun: "+(data.penamaakaun||"")+"\nNota: "+(data.nota||"");
    await hantarMesej("601123726341", notifMsg);
  } catch (err) { console.error("Error simpan order:", err); }
}

async function hantarMesej(phoneNumber, mesej) {
  if (!mesej || !mesej.trim()) { console.error("Mesej kosong — skip hantar"); return; }
  var cuba = 0;
  while (cuba < 3) {
    try {
      await axios.post("https://api.wassenger.com/v1/messages", { phone: phoneNumber, message: mesej }, { headers: { Token: WASSENGER_TOKEN } });
      return;
    } catch (err) { cuba++; console.error("Error hantar mesej cuba " + cuba + ":", err.message); if (cuba < 3) await new Promise(function(r) { setTimeout(r, 2000); }); }
  }
}

async function hantarGambar(phoneNumber, mesej, gambarUrl) {
  if (!mesej || !mesej.trim()) mesej = "😊";
  var cuba = 0;
  while (cuba < 3) {
    try {
      await axios.post("https://api.wassenger.com/v1/messages", { phone: phoneNumber, message: mesej, media: { url: gambarUrl } }, { headers: { Token: WASSENGER_TOKEN } });
      return;
    } catch (err) { cuba++; console.error("Error hantar gambar cuba " + cuba + ":", err.message); if (cuba < 3) await new Promise(function(r) { setTimeout(r, 2000); }); }
  }
}

function getBajuTerakhir(history, products) {
  var historyLower = history.toLowerCase();
  var bajuTerakhir = null; var lastIdx = -1; var uniqueNama = [];
  products.forEach(function(p) { if (!p || !p.Nama) return; if (uniqueNama.indexOf(p.Nama) === -1) uniqueNama.push(p.Nama); });
  uniqueNama.forEach(function(nama) { var idx = historyLower.lastIndexOf(nama.toLowerCase()); if (idx > lastIdx) { lastIdx = idx; bajuTerakhir = nama; } });
  return bajuTerakhir;
}

function sanitizeJawapan(text) {
  text = text.replace(/!\[.*?\]\(.*?\)/g, "");
  text = text.replace(/\[.*?\]\(.*?\)/g, "");
  text = text.replace(/https?:\/\/\S+/g, "");
  text = text.replace(/\*\*(.*?)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

async function callClaude(systemPrompt, messages, maxTokens) {
  var cuba = 0;
  while (cuba < 3) {
    try {
      var response = await claude.messages.create({ model: "claude-sonnet-4-5", max_tokens: maxTokens || 500, temperature: 0, system: systemPrompt, messages: messages });
      return response.content[0].text;
    } catch (err) { cuba++; if (cuba === 3) throw err; await new Promise(function(r) { setTimeout(r, 2000); }); }
  }
}

async function claudeDecideGambar(jawapan, history, products, katalog, sizeChartImages) {
  try {
    var senaraiGambar = [];
    katalog.forEach(function(k) { if (k && k.Nama && k.Gambar_URL) senaraiGambar.push("KATALOG:" + k.Nama + "|" + k.Gambar_URL); });
    products.forEach(function(p) { if (p && p.Nama && p.Warna && p.Gambar_URL) senaraiGambar.push("WARNA:" + p.Nama + " " + p.Warna + "|" + p.Gambar_URL); });
    sizeChartImages.forEach(function(s) { if (s && s.Nama && s.Gambar_URL) senaraiGambar.push("SIZECHART:" + s.Nama + "|" + s.Gambar_URL); });
    var decisionPrompt = "Kamu adalah sistem yang memutuskan gambar mana perlu dihantar kepada buyer.\n\nJawapan bot kepada buyer:\n" + jawapan + "\n\nHistory conversation:\n" + history.slice(-1000) + "\n\nSenarai gambar yang ada (format JENIS:NAMA|URL):\n" + senaraiGambar.join("\n") + "\n\nTUGASAN: Berdasarkan jawapan bot dan context conversation, tentukan gambar mana perlu dihantar.\nPERATURAN:\n- Kalau bot propose BEBERAPA baju → hantar KATALOG setiap baju yang disebut\n- Kalau bot tunjuk warna specific → hantar WARNA yang berkaitan\n- Kalau bot tanya saiz/ukuran → hantar SIZECHART baju berkaitan\n- Kalau bot sekadar jawab soalan biasa tanpa tunjuk produk → jawab TIADA\n- Kalau dalam order flow (tanya alamat, payment, QR dll) → jawab TIADA\n- Kalau buyer dah close/tolak/terima kasih → jawab TIADA\n\nJawab HANYA dalam format ini:\nHANTAR:URL_GAMBAR\natau\nTIADA\n\nJANGAN tulis apa-apa lain.";
    var decision = await callClaude(decisionPrompt, [{ role: "user", content: "Tentukan gambar." }], 300);
    decision = decision.trim();
    if (decision === "TIADA" || !decision.includes("HANTAR:")) return [];
    var urls = [];
    decision.split("\n").forEach(function(line) { line = line.trim(); if (line.startsWith("HANTAR:")) { var url = line.replace("HANTAR:", "").trim(); if (url) urls.push(url); } });
    return urls;
  } catch (err) { console.error("Error claudeDecideGambar:", err.message); return []; }
}

async function extractOrderDetails(history, products) {
  try {
    var uniqueNama = [];
    products.forEach(function(p) { if (!p || !p.Nama) return; if (uniqueNama.indexOf(p.Nama) === -1) uniqueNama.push(p.Nama); });
    var extractPrompt = "Dari conversation ini, extract maklumat order yang buyer pilih.\n\nHistory:\n" + history.slice(-2000) + "\n\nProduk yang ada: " + uniqueNama.join(", ") + "\n\nJawab HANYA dalam format ini (kosongkan kalau tak ada info):\nPRODUK:[nama produk]\nSAIZ:[saiz pilihan]\nWARNA:[warna pilihan]\n\nJANGAN tulis apa-apa lain.";
    var result = await callClaude(extractPrompt, [{ role: "user", content: "Extract order details." }], 100);
    var produk = ""; var saiz = ""; var warna = "";
    result.split("\n").forEach(function(line) {
      line = line.trim();
      if (line.startsWith("PRODUK:")) produk = line.replace("PRODUK:", "").trim();
      if (line.startsWith("SAIZ:")) saiz = line.replace("SAIZ:", "").trim();
      if (line.startsWith("WARNA:")) warna = line.replace("WARNA:", "").trim();
    });
    return { produk: produk, saiz: saiz, warna: warna };
  } catch (err) { console.error("Error extract order details:", err.message); return { produk: "", saiz: "", warna: "" }; }
}

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
    if (global.stopList && global.stopList[phone]) continue;
    if (q.stage === "browsing") {
      if (!q.sent1 && !q.hasJanji && (now - q.lastReply) >= 60 * 60 * 1000) { await hantarMesej(phone, MSG_STAGE1); followUpQueue[phone].sent1 = true; console.log("Stage 1 sent to " + phone); }
      if (q.hasJanji && !q.sent1b && q.janjiAt && (now - q.janjiAt) >= 3 * 60 * 60 * 1000) {
        try {
          var followUp1b = await callClaude("Tulis follow up WhatsApp mesra Bahasa Malaysia. 2-3 ayat pendek. Panggil Cik. Jangan sebut harga. Teks biasa sahaja.", [{ role: "user", content: "Buyer kata: '" + q.lastContext + "'. Tulis follow up." }], 150);
          await hantarMesej(phone, followUp1b); followUpQueue[phone].sent1b = true; followUpQueue[phone].sent1 = true; console.log("Stage 1b sent to " + phone);
        } catch (err) { console.error("Error stage 1b:", err.message); }
      }
      if (q.sent1 && !q.sent2 && (now - q.lastReply) >= 24 * 60 * 60 * 1000) { await hantarMesej(phone, MSG_STAGE2); followUpQueue[phone].sent2 = true; followUpQueue[phone].done = true; console.log("Stage 2 sent to " + phone); }
    }
    if (q.stage === "ordered") {
      if (!q.sent3a && q.orderedAt && (now - q.orderedAt) >= 3 * 60 * 60 * 1000) {
        if (q.produk && q.saiz && q.warna) {
          try {
            delete sheetCache["Sheet1"];
            var products = await getSheetDataCached("Sheet1");
            var stokBaju = products.find(function(p) { return p && p.Nama && p.Warna && p.Nama.toLowerCase().includes(q.produk.toLowerCase()) && p.Warna.toLowerCase().includes(q.warna.toLowerCase()); });
            var saizKey = "Stock_" + q.saiz.toUpperCase();
            if (stokBaju && parseInt(stokBaju[saizKey] || "0") <= 0) {
              await hantarMesej(phone, "Salam Cik 😊\n\nMaaf ya, stok " + q.produk + " warna " + q.warna + " saiz " + q.saiz + " dah habis terjual.\n\nBoleh Cik pilih warna atau saiz lain? Kami ada stok warna lain yang cantik juga 😊");
              followUpQueue[phone].done = true; console.log("Stok habis — follow up distop: " + phone); continue;
            }
          } catch (err) { console.error("Error semak stok follow up:", err.message); }
        }
        await hantarMesej(phone, MSG_STAGE3A); followUpQueue[phone].sent3a = true; console.log("Stage 3a sent to " + phone);
      }
      if (q.sent3a && !q.sent3b && q.orderedAt && (now - q.orderedAt) >= 24 * 60 * 60 * 1000) {
        if (q.produk && q.saiz && q.warna) {
          try {
            delete sheetCache["Sheet1"];
            var products3b = await getSheetDataCached("Sheet1");
            var stokBaju3b = products3b.find(function(p) { return p && p.Nama && p.Warna && p.Nama.toLowerCase().includes(q.produk.toLowerCase()) && p.Warna.toLowerCase().includes(q.warna.toLowerCase()); });
            var saizKey3b = "Stock_" + q.saiz.toUpperCase();
            if (stokBaju3b && parseInt(stokBaju3b[saizKey3b] || "0") <= 0) {
              await hantarMesej(phone, "Salam Cik 😊\n\nMaaf ya, stok " + q.produk + " warna " + q.warna + " saiz " + q.saiz + " dah habis.\n\nBoleh Cik whatsapp kami semula untuk pilih warna atau saiz lain yang masih ada stok 😊");
              followUpQueue[phone].done = true; console.log("Stok habis 3b — follow up distop: " + phone); continue;
            }
          } catch (err) { console.error("Error semak stok follow up 3b:", err.message); }
        }
        await hantarMesej(phone, MSG_STAGE3B); followUpQueue[phone].sent3b = true; followUpQueue[phone].done = true; console.log("Stage 3b sent to " + phone);
      }
    }
  }
}, 30 * 1000);

setInterval(async function() {
  try {
    var auth = await getGoogleAuth();
    var sheets = google.sheets({ version: "v4", auth });
    var result = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Orders!A:T" });
    var rows = result.data.values || [];
    if (rows.length <= 1) return;
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var noTel = row[2] || ""; var status = row[12] || ""; var trackingNo = row[13] || ""; var courier = row[14] || ""; var notifiedPacked = row[15] || ""; var notifiedShipped = row[16] || "";
      if (!noTel) continue;
      if (status === "Packed" && notifiedPacked !== "Yes") {
        await hantarMesej(noTel, "Assalamualaikum Cik! 😊\n\nOrder Cik sedang dipacking sekarang.\nKami akan maklumkan bila dah dihantar ya ❤️");
        await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: "Orders!P" + (i + 1), valueInputOption: "RAW", resource: { values: [["Yes"]] } });
        console.log("Notif Packed dihantar ke: " + noTel);
      }
      if (status === "Shipped" && notifiedShipped !== "Yes" && trackingNo) {
        var courierUrl = "";
        if (courier.toLowerCase().includes("j&t")) courierUrl = "www.jtexpress.my";
        else if (courier.toLowerCase().includes("poslaju")) courierUrl = "www.poslaju.com.my";
        else if (courier.toLowerCase().includes("ninja")) courierUrl = "www.ninjavan.co/ms-my";
        else if (courier.toLowerCase().includes("gdex")) courierUrl = "www.gdexpress.com";
        await hantarMesej(noTel, "Assalamualaikum Cik! 😊\n\nOrder Cik telah dihantar!\nCourier: " + courier + "\nNo Tracking: " + trackingNo + "\n\n" + (courierUrl ? "Track di: " + courierUrl + "\n" : "") + "Anggaran tiba: 3-5 hari bekerja ❤️");
        await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: "Orders!Q" + (i + 1), valueInputOption: "RAW", resource: { values: [["Yes"]] } });
        console.log("Notif Shipped dihantar ke: " + noTel);
      }
    }
  } catch (err) { console.error("Error check order status:", err); }
}, 2 * 60 * 1000);

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
      for (var j = 0; j < headers.length; j++) { row[headers[j]] = values[j] || ""; }
      if (sheetName === "Sheet1" && !row.Nama) continue;
      rows.push(row);
    }
    return rows;
  } catch (err) { console.error("Sheet error:", err); return []; }
}

function buatSystemPrompt(products, sizeChart, produkDetail, bajuKonteks, dalamOrderFlow, tarikhSekarang, promoAktif) {
  var senaraiProduk = products.map(function(p) {
    if (!p || !p.Nama) return "";
    // ===== OVERRIDE HARGA DENGAN PROMO =====
    var hargaXS2XL = p.Harga_XS_2XL;
    var harga3XL4XL = p.Harga_3XL_4XL;
    if (promoAktif && promoAktif.length > 0) {
      promoAktif.forEach(function(promo) {
        if (promo.Baju && promo.Harga_Promo && p.Nama.toLowerCase().includes(promo.Baju.toLowerCase())) {
          hargaXS2XL = promo.Harga_Promo + " (HARGA PROMO)";
          harga3XL4XL = (promo.Harga_Promo_3XL4XL || (parseInt(promo.Harga_Promo) + 10)) + " (HARGA PROMO)";
        }
      });
    }
    return p.Nama + " | Warna: " + p.Warna +
      " | Harga XS-2XL: RM" + hargaXS2XL +
      " | Harga 3XL-4XL: RM" + harga3XL4XL + " (ADD ON RM10)" +
      " | Stok: XS=" + p.Stock_XS + " S=" + p.Stock_S + " M=" + p.Stock_M +
      " L=" + p.Stock_L + " XL=" + p.Stock_XL + " 2XL=" + p.Stock_2XL +
      " 3XL=" + p.Stock_3XL + " 4XL=" + p.Stock_4XL;
  }).filter(Boolean).join("\n");

  var sizeInfo = {};
  sizeChart.forEach(function(row) {
    if (!row.Ukuran) return;
    if (!sizeInfo[row.Ukuran]) sizeInfo[row.Ukuran] = {};
    ["XS","S","M","L","XL","2XL","3XL","4XL"].forEach(function(s) { sizeInfo[row.Ukuran][s] = row[s] || ""; });
  });
  var sizeText = "Panduan Saiz:\n";
  Object.keys(sizeInfo).forEach(function(ukuran) {
    sizeText += ukuran + ": " + ["XS","S","M","L","XL","2XL","3XL","4XL"].map(function(s) { return s + "=" + sizeInfo[ukuran][s]; }).join(", ") + "\n";
  });

  var detailText = "Detail Produk:\n";
  produkDetail.forEach(function(p) {
    if (!p || !p.Nama) return;
    detailText += p.Nama + " | Material: " + p.Material + " | Cutting: " + p.Cutting + " | Feature: " + p.Feature + " | Sesuai untuk: " + p.Sesuai_Untuk + "\n";
  });

  var tarikhText = "";
  if (tarikhSekarang) tarikhText = "\nTARIKH SEKARANG: " + tarikhSekarang + "\nGuna tarikh ini untuk kira anggaran sampai bila buyer tanya.\n";

  var konteksText = "";
  if (bajuKonteks) konteksText = "\nKONTEKS PENTING: Buyer ini sedang bertanya tentang " + bajuKonteks + ". Fokuskan jawapan pada baju ini sahaja melainkan buyer secara explicit minta tengok baju lain.\n";

  var orderFlowText = "";
  if (dalamOrderFlow) orderFlowText = "\nSTATUS ORDER: Buyer sudah memilih baju dan sedang dalam proses order. JANGAN cadang atau propose baju lain. Bila buyer tanya tentang material atau ciri-ciri baju — jawab info baju yang dipilih sahaja. Hanya propose baju lain kalau buyer kata nak tukar baju atau tak jadi beli.\n";

  // ===== PROMO TEXT =====
  var promoText = "";
  if (promoAktif && promoAktif.length > 0) {
    promoText = "\nPROMO SEMASA:\n";
    // Gift promo
    var promoGift = promoAktif.filter(function(p) { return p.Gift && p.Gift.trim(); });
    if (promoGift.length > 0) {
      var giftsDisebut = [];
      promoGift.forEach(function(p) {
        var key = p.Nama_Promo + "|" + p.Gift;
        if (giftsDisebut.indexOf(key) === -1) {
          giftsDisebut.push(key);
          promoText += "- " + p.Nama_Promo + ": " + (p.Syarat ? p.Syarat + " → " : "") + "dapat " + p.Gift + "\n";
        }
      });
    }
    // Harga promo
    var promoHarga = promoAktif.filter(function(p) { return p.Baju && p.Harga_Promo; });
    if (promoHarga.length > 0) {
      promoText += "HARGA PROMO SPECIAL:\n";
      promoHarga.forEach(function(p) {
        promoText += "- " + p.Baju + ": RM" + p.Harga_Promo + " (XS-2XL), RM" + (p.Harga_Promo_3XL4XL || (parseInt(p.Harga_Promo) + 10)) + " (3XL-4XL)\n";
      });
    }
    promoText += "Sebut promo bila buyer hampir nak beli atau tanya harga. Gunakan sebagai urgency untuk close.\n";
  }

  return "Kamu adalah pembantu jualan kedai baju ADEL Adyana Elegance. Jawab dalam Bahasa Malaysia Baku yang ringkas, mesra dan profesional.\n" +
    "PENTING: Panggil pelanggan sebagai Cik sahaja.\n" +
    "BAHASA: Gunakan HANYA Bahasa Malaysia. DILARANG guna perkataan Indonesia seperti cocok, oke, yuk, dong, sih, deh, banget, dikonfirmasi, konfirmasi.\n" +
    "Guna perkataan Malaysia: 'disahkan' bukan 'dikonfirmasi', 'sesuai' bukan 'cocok', 'baik' bukan 'oke'.\n" +
    "GAYA: Ayat pendek, mudah faham, profesional. Maksimum 3-4 ayat per jawapan.\n\n" +
    tarikhText + promoText + konteksText + orderFlowText +
    "SALES FLOW — BILA LEAD MASUK SPECIFIC DESIGN:\n" +
    "1. ACKNOWLEDGE MINAT — Puji pilihan buyer, jangan reply generic. Contoh: 'Cantik pilihan Cik! [Nama Design] memang antara bestseller kami'\n" +
    "2. JANGAN sebut harga dalam introduction — fokus tanya warna dan saiz dulu\n" +
    "3. TERUS CHECK SIZE — Jangan spam detail produk. Tanya: berat badan, ukuran dada (inchi), biasa pakai size apa\n" +
    "4. BUILD CONFIDENCE — Selepas suggest size, tambah reassurance. Contoh: 'Cutting design ni memang cantik jatuh dan selesa pakai'\n" +
    "5. SOFT CLOSE — Jangan tunggu lama. Contoh: 'Size Cik masih available. Kalau Cik nak saya boleh bantu lock siap-siap dulu'\n" +
    "6. JANGAN spam semua warna bila buyer dah pilih design — tanya warna apa yang diminati\n" +
    "7. JANGAN explain technical panjang — buyer nak beli bukan belajar\n\n" +
    "PRODUK:\n" + senaraiProduk + "\n\n" +
    "PANDUAN SAIZ:\n" + sizeText + "\n\n" +
    "DETAIL PRODUK:\n" + detailText + "\n\n" +
    "PERATURAN:\n" +
    "- Harga HANYA sebut bila pelanggan tanya atau dah setuju nak beli\n" +
    "- Bila sebut harga, WAJIB semak promo aktif dan inform buyer tentang promo sekaligus\n" +
    "- Contoh: 'Harga RM85 (XS-2XL). Sekarang ada PROMO FREE POSTAGE untuk Semenanjung 😊'\n" +
    "- Bila pelanggan tanya warna — senaraikan warna yang ada SAHAJA dalam teks\n" +
    "- Untuk recommend saiz, WAJIB tanya ukuran dada (inchi) dan berat badan (kg) — kedua-dua penting\n" +
    "- JANGAN tanya tinggi — tidak relevan untuk sizing baju kurung\n" +
    "- Bila pelanggan kata 'nak ukur dulu', 'ukur baju dulu', 'ukur badan dulu' — maksudnya mereka nak ukur sendiri di rumah\n" +
    "- Bantu dengan cara ukur: guna pita ukur, ukur bahagian dada dalam INCHI\n" +
    "- Cara ukur: lilit pita ukur di sekeliling bahagian dada, pastikan tidak terlalu ketat dan tidak terlalu longgar\n" +
    "- JANGAN sebut datang kedai, fitting, atau arrange appointment\n" +
    "- Semua ukuran dalam INCHI bukan cm\n" +
    "- Untuk soalan tentang feature baju, rujuk DETAIL PRODUK sahaja\n" +
    "- JANGAN tekaan atau tambah feature yang tidak ada dalam DETAIL PRODUK\n" +
    "- Kalau feature tidak disebut dalam DETAIL PRODUK — jawab: 'Untuk maklumat lanjut boleh hubungi admin kami ya Cik'\n" +
    "- Jika stok = 0: beritahu habis, cadang warna lain, kalau tak nak cadang baju lain\n" +
    "- Saiz 3XL dan 4XL ada tambahan RM10\n" +
    "- XXL = 2XL, XXXL = 3XL, XXXXL = 4XL — semua merujuk saiz yang sama\n" +
    "- Kaedah Pembayaran: Bank Transfer, QR Pay atau COD\n" +
    "- COD: Tambah RM4 kepada kos postage\n" +
    "- COD boleh untuk SEMUA kawasan termasuk Semenanjung, Sabah dan Sarawak\n" +
    "- Kalau ada promo free postage — JANGAN kira postage dalam total. Terus beritahu total tanpa postage dan sebut 'FREE POSTAGE'\n" +
    "- Contoh betul: 'Total Cik: RM90. FREE POSTAGE untuk Semenanjung 😊'\n" +
    "- Contoh salah: 'Total RM96. Ada promo free postage jimat RM6' — ini confuse buyer\n" +
    "- QR Pay: Buyer boleh scan QR code untuk bayar terus\n" +
    "- Selepas QR Pay, minta resit dan nama penama akaun\n" +
    "- Kadar Postage Semenanjung: 1pcs RM6, 2-5pcs RM4/pcs, 6pcs ke atas RM2/pcs\n" +
    "- Kadar Postage Sabah & Sarawak: 1pcs RM13, 2-5pcs RM8/pcs, 6pcs ke atas RM6/pcs\n" +
    "- Maklumat Akaun Bank: MAYBANK | Adel Adyana Elegance | 551100323485\n" +
    "- Anggaran masa penghantaran:\n" +
    "  Semenanjung Malaysia: 3-5 hari bekerja\n" +
    "  Sabah & Sarawak: 5-7 hari bekerja\n" +
    "- Bila buyer tanya bila sampai atau berapa lama hantar, jawab berdasarkan lokasi mereka\n" +
    "- Bila buyer tanya sempat sampai sebelum sesuatu tarikh, kira berdasarkan TARIKH SEKARANG + hari bekerja (exclude Sabtu, Ahad, cuti umum)\n" +
    "- Semenanjung: 3-5 hari bekerja, Sabah/Sarawak: 5-7 hari bekerja\n" +
    "- Jawab jujur — kalau tak sempat, beritahu dengan baik dan cadang buyer order awal untuk majlis seterusnya\n" +
    "- Cuti umum dan Hari Raya Malaysia dikira sebagai bukan hari bekerja\n" +
    "- 'Raya' yang dimaksudkan buyer boleh merujuk Aidilfitri ATAU Aidiladha — semak konteks dan tarikh sekarang\n" +
    "- Hari Raya Aidiladha 2026 jatuh pada 27 Mei 2026 (Rabu)\n" +
    "- Hari Raya Aidilfitri 2026 jatuh pada 21 Mac 2026 (dah lepas)\n" +
    "- Kalau buyer sebut 'raya' tanpa specify — assume raya yang paling dekat dengan tarikh sekarang\n" +
    "- Bila buyer tanya sempat sampai sebelum raya/tarikh tertentu SEBELUM order:\n" +
    "  1. Jawab jujur sama ada sempat atau tidak\n" +
    "  2. Kalau sempat — terus guna sebagai urgency untuk close: 'Sempat Cik! Tapi kena order hari ni/segera supaya sempat diproses'\n" +
    "  3. Kalau tak sempat — jangan putus asa, cadang: 'Untuk raya ni dah tak sempat, tapi Cik boleh order sekarang untuk majlis seterusnya. Stok terhad!'\n" +
    "  4. JANGAN sekadar jawab sempat/tak sempat sahaja — sentiasa guide ke arah order\n" +
    "- Selepas transfer, minta resit dan nama penama akaun bank\n" +
    "- Kamu BOLEH hantar gambar — gambar akan dihantar automatik\n" +
    "- JANGAN kata tidak boleh hantar gambar\n" +
    "- JANGAN tulis placeholder seperti [Sistem akan hantar gambar] atau [gambar katalog]\n" +
    "- JANGAN sebut 'sistem akan hantar', 'tunggu sebentar', 'saya hantar sekarang'\n" +
    "- Terus jawab natural sahaja, gambar akan keluar automatik\n" +
    "- JANGAN tanya 'nak saya tunjukkan gambar?' atau 'nak tengok?' — terus jawab dan gambar akan keluar automatik\n" +
    "- LARANGAN MUTLAK: JANGAN tulis URL, link, markdown, bold dalam jawapan\n" +
    "- JANGAN sekali-kali tulis format ![...](url) atau [text](url)\n" +
    "- JANGAN senaraikan link gambar — gambar dihantar automatik oleh sistem\n" +
    "- Flow order:\n" +
    "  1. Confirm beli → tanya lokasi (Semenanjung/Sabah/Sarawak)\n" +
    "  2. Kira postage → semak promo dulu → kalau ada free postage apply dulu baru beritahu total\n" +
    "  3. Tanya kaedah bayar (Bank Transfer/QR Pay/COD)\n" +
    "  4. COD → tulis ORDER_COD_CONFIRMED\n" +
    "  4b. Resit bank transfer/QR → tulis ORDER_RECEIPT_RECEIVED\n" +
    "  5. Minta details penghantaran\n" +
    "  6. Semua details lengkap → WAJIB tulis tepat seperti ini tanpa ubah format: ORDER_CONFIRMED:nama|notel|alamat|poskod|bandar|negeri|produk|saiz|warna|harga|postage|total|kaedahbayar|penamaakaun|nota\n" +
    "  PENTING: ORDER_CONFIRMED mesti ditulis dalam jawapan — ini adalah trigger sistem untuk simpan order.\n" +
    "- JANGAN minta details sebelum resit atau COD confirm\n" +
    "- Jika tanya size chart, jawab: Ini size chart untuk Cik 😊\n" +
    "- WAJIB: Setiap jawapan ada soalan susulan\n" +
    "- Jawapan teks biasa sahaja\n" +
    "- JANGAN tambah ucapan perayaan (hari raya, christmas, tahun baru dll) melainkan buyer sebut dulu\n" +
    "- JANGAN tambah ayat perpisahan panjang — maksimum 1 ayat ringkas sahaja\n" +
    "- Bila buyer kata 'tq', 'terima kasih', 'xperlu', 'takpe' selepas bot propose alternatif — buyer dah close, jawab ringkas dan JANGAN hantar gambar lagi\n" +
    "- Contoh jawapan close: 'Baik Cik, tiada masalah. Nanti bila ada koleksi baru kami akan maklumkan ya 😊'\n" +
    "- JANGAN propose lagi selepas buyer close conversation\n" +
    "- Dalam ORDER_CONFIRMED, field nota HANYA isi maklumat ringkas. JANGAN masukkan ucapan panjang dalam nota.\n" +
    "- Polisi Penukaran/Pertukaran:\n" +
    "  1. DEFECT: Baju boleh ditukar jika ada kecacatan. Buyer whatsapp admin dan hantar gambar bukti defect. Selepas admin verify, buyer pos balik kepada kami. Bila kami terima, kami akan pos baju baru.\n" +
    "  2. SALAH SAIZ: Buyer boleh tukar saiz dengan whatsapp admin. Buyer perlu pos balik baju dan buat bayaran kos pos baju baru selepas kami terima baju yang tersalah saiz.\n" +
    "  3. TIADA pertukaran untuk sebab lain selain defect atau salah saiz.\n" +
    "  4. Untuk kedua-dua kes, minta buyer hubungi admin terus untuk proses lanjut.";
}

app.get("/", function(req, res) { res.send("Bot ADEL Adyana OK"); });

app.post("/webhook", async function(req, res) {
  try {
    var data = req.body;
    if (data.event !== "message:in:new") return res.sendStatus(200);
    if (data.data.fromMe) return res.sendStatus(200);

    var from = data.data.chatId || data.data.from || (data.data.chat && data.data.chat.id) || (data.data.contact && data.data.contact.wid) || "";
    var text = data.data.body || data.data.text || data.data.caption || data.data.message || "";

    var quotedText = ""; var quotedMsgId = "";
    if (data.data.quotedMsg) { quotedText = data.data.quotedMsg.body || data.data.quotedMsg.caption || ""; quotedMsgId = data.data.quotedMsg.id || ""; }
    else if (data.data.contextInfo && data.data.contextInfo.quotedMessage) { var qMsg = data.data.contextInfo.quotedMessage; quotedText = qMsg.conversation || qMsg.caption || (qMsg.extendedTextMessage && qMsg.extendedTextMessage.text) || ""; quotedMsgId = data.data.contextInfo.stanzaId || ""; }

    if (quotedMsgId && !quotedText) {
      try {
        var qMediaData = await axios.get("https://api.wassenger.com/v1/messages/" + quotedMsgId + "/media", { headers: { Token: WASSENGER_TOKEN }, responseType: "arraybuffer" });
        var qBase64 = Buffer.from(qMediaData.data).toString("base64"); var qMediaType = qMediaData.headers["content-type"] || "image/jpeg";
        var qVision = await claude.messages.create({ model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: qMediaType, data: qBase64 } }, { type: "text", text: "Gambar baju ini. Nyatakan nama baju dan warna yang tertera dalam gambar. Jawab dalam format: BAJU: [nama] | WARNA: [warna]. Kalau tak nampak, jawab TIADA." }] }] });
        var qVisionText = qVision.content[0].text.trim();
        if (qVisionText !== "TIADA") quotedText = qVisionText;
      } catch (err) { console.error("Error quoted vision:", err.message); }
    }
    if (quotedText) text = "[Buyer quote gambar — " + quotedText + "] " + text;
    if (quotedMsgId && !quotedText && text && text.length < 30) text = text + " [NOTA SISTEM: Buyer mungkin quote gambar untuk pilih warna. Minta buyer taip nama warna yang dipilih untuk elak kesilapan hantar baju.]";

    var hasMedia = data.data.hasMedia || data.data.type === "image" || data.data.type === "document";
    var isVoice = data.data.type === "audio" || data.data.type === "ptt";
    var phoneNumber = from.replace("@c.us", "").replace("@s.whatsapp.net", "").replace("@lid", "");
    if (!phoneNumber) return res.sendStatus(200);

    if (!text && isVoice) { await hantarMesej(phoneNumber, "Maaf Cik, saya tidak dapat dengar voice note. Boleh Cik taip mesej anda? 😊"); return res.sendStatus(200); }

    if (!text && hasMedia) {
      try {
        var mediaData = await axios.get("https://api.wassenger.com/v1/messages/" + data.data.id + "/media", { headers: { Token: WASSENGER_TOKEN }, responseType: "arraybuffer" });
        var base64Image = Buffer.from(mediaData.data).toString("base64"); var mediaType = mediaData.headers["content-type"] || "image/jpeg";
        var visionResponse = await claude.messages.create({ model: "claude-sonnet-4-5", max_tokens: 300, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } }, { type: "text", text: "Ini gambar dari buyer. Kalau ada alamat penghantaran, extract dan tulis semula dalam teks biasa. Kalau ini resit pembayaran, tulis 'RESIT'. Kalau bukan alamat atau resit, tulis 'TIADA'." }] }] });
        var extractedText = visionResponse.content[0].text.trim();
        console.log("Vision extract:", extractedText);
        if (extractedText === "TIADA") { return res.sendStatus(200); }
        else if (extractedText === "RESIT") {
          if (followUpQueue[phoneNumber] && followUpQueue[phoneNumber].stage === "ordered") { followUpQueue[phoneNumber].stage = "paid"; followUpQueue[phoneNumber].done = true; followUpQueue[phoneNumber].sent3a = true; followUpQueue[phoneNumber].sent3b = true; await hantarMesej(phoneNumber, "Terima kasih Cik! Resit dah kami terima. Boleh Cik berikan nama penuh dan alamat penghantaran? 😊"); }
          return res.sendStatus(200);
        } else { text = extractedText; }
      } catch (err) { console.error("Error vision:", err.message); return res.sendStatus(200); }
    }

    if (!from || !text) return res.sendStatus(200);

    if (!global.stopList) global.stopList = {};
    if (phoneNumber === "601123726341") {
      if (text.startsWith("/stop ")) { var stopNum = text.replace("/stop ", "").trim(); global.stopList[stopNum] = true; await hantarMesej(phoneNumber, "Bot distop untuk: " + stopNum + " ✅"); return res.sendStatus(200); }
      if (text.startsWith("/start ")) { var startNum = text.replace("/start ", "").trim(); delete global.stopList[startNum]; await hantarMesej(phoneNumber, "Bot diaktif semula untuk: " + startNum + " ✅"); return res.sendStatus(200); }
      if (text.startsWith("/inject ")) { var parts = text.replace("/inject ", "").trim(); var spaceIdx = parts.indexOf(" "); var targetNum = parts.substring(0, spaceIdx); var injectText = parts.substring(spaceIdx + 1); if (!sesi[targetNum]) sesi[targetNum] = []; sesi[targetNum].push({ role: "user", content: injectText }); await simpanSesi(targetNum, sesi[targetNum]); await hantarMesej(phoneNumber, "Inject berjaya untuk: " + targetNum + " ✅"); return res.sendStatus(200); }
    }
    if (global.stopList[phoneNumber]) { console.log("Bot distop untuk: " + phoneNumber); return res.sendStatus(200); }

    if (text.trim() === "/reset") { sesi[phoneNumber] = []; await simpanSesi(phoneNumber, []); followUpQueue[phoneNumber] = { stage: "browsing", lastReply: Date.now(), sent1: false, sent1b: false, sent2: false, sent3a: false, sent3b: false, hasJanji: false, lastContext: "", janjiAt: null, orderedAt: null, done: false, produk: "", saiz: "", warna: "" }; await hantarMesej(phoneNumber, "Sesi telah direset. Boleh saya bantu Cik? 😊"); return res.sendStatus(200); }

    if (detectPromptInjection(text)) { await hantarMesej(phoneNumber, "Maaf Cik, saya hanya boleh membantu berkaitan produk ADEL Adyana Elegance. 😊"); await hantarMesej("601123726341", "PROMPT INJECTION!\nNo: " + phoneNumber + "\nMesej: " + text); return res.sendStatus(200); }

    var katatukar = ["nak tukar","nk tukar","tukar alamat","tukar baju","tukar saiz","tukar size","tukar warna","ubah alamat","ubah baju","ubah saiz","ubah size","ubah warna","salah alamat","salah saiz","salah size","salah baju","salah warna","boleh tukar","boleh ubah","cancel","batalkan"];
    if (katatukar.some(function(k) { return text.toLowerCase().includes(k); })) await hantarMesej("601123726341", "PERHATIAN - REQUEST PENUKARAN!\n\nNo Tel: " + phoneNumber + "\nMesej: " + text + "\n\nSila semak segera!");

    var kataTolak = ["tak nak","taknak","xnak","tak jadi","takjadi","tak minat","takminat","x minat","tidak berminat","tak berminat","cancel","batalkan","tak berkenan","tak perlu","takpe","ok takpe","xpe","dah ada","dah beli","mahal","tak mampu","budget tak cukup","lain kali","maybe later","next time","tak dulu","xperlu","x perlu","tak perlu hantar","xde tq","takde tq","no thanks","takpe tq","dah taknak","xnak dah"];
    if (kataTolak.some(function(k) { return text.toLowerCase().includes(k); })) { if (followUpQueue[phoneNumber]) { followUpQueue[phoneNumber].done = true; followUpQueue[phoneNumber].sent1 = true; followUpQueue[phoneNumber].sent2 = true; console.log("Buyer tolak — follow up distop: " + phoneNumber); } }

    if (!followUpQueue[phoneNumber]) {
      followUpQueue[phoneNumber] = { stage: "browsing", lastReply: Date.now(), sent1: false, sent1b: false, sent2: false, sent3a: false, sent3b: false, hasJanji: false, lastContext: "", janjiAt: null, orderedAt: null, done: false, produk: "", saiz: "", warna: "" };
    } else {
      if (followUpQueue[phoneNumber].stage === "browsing") { followUpQueue[phoneNumber].lastReply = Date.now(); followUpQueue[phoneNumber].done = false; }
      else if (followUpQueue[phoneNumber].stage === "ordered") { followUpQueue[phoneNumber].lastReply = Date.now(); }
    }

    if (!sesi[phoneNumber]) { sesi[phoneNumber] = await loadSesi(phoneNumber); }
    sesi[phoneNumber].push({ role: "user", content: text });

    var products = await getSheetDataCached("Sheet1");
    var sizeChart = await getSheetDataCached("Size Chart");
    var produkDetail = await getSheetDataCached("produkDetail");
    var sizeChartImages = await getSheetDataCached("sizeChartImages");
    var katalog = await getSheetDataCached("Katalog");
    var gambarReal = await getSheetDataCached("GambarReal");
    var promoData = await getSheetDataCached("Promo");
    var textLower = text.toLowerCase();
    var history = sesi[phoneNumber].map(function(m) { return m.content; }).join(" ");

    var today = new Date();
    var promoAktif = promoData.filter(function(p) {
      if (!p || p.Aktif !== "YES") return false;
      try { var mula = new Date(p.Tarikh_Mula); var tamat = new Date(p.Tarikh_Tamat); return today >= mula && today <= tamat; } catch (e) { return false; }
    });

    var bajuDalamMesej = null; var uniqueNamaCek = [];
    products.forEach(function(p) { if (!p || !p.Nama) return; if (uniqueNamaCek.indexOf(p.Nama) === -1) uniqueNamaCek.push(p.Nama); });
    uniqueNamaCek.forEach(function(nama) { if (textLower.includes(nama.toLowerCase())) bajuDalamMesej = nama; });
    var bajuKonteks = bajuDalamMesej || getBajuTerakhir(history, products);

    var historyLower = history.toLowerCase();
    var dalamOrderFlow = historyLower.includes("postage") || historyLower.includes("total") || historyLower.includes("bank transfer") || historyLower.includes("cod") || historyLower.includes("nak beli") || historyLower.includes("order");

    var tarikhSekarang = new Date().toLocaleDateString("ms-MY", { timeZone: "Asia/Kuala_Lumpur", weekday: "long", year: "numeric", month: "long", day: "numeric" });

    // ===== BUILD SYSTEM PROMPT DENGAN PROMO =====
    var systemPrompt = buatSystemPrompt(products, sizeChart, produkDetail, bajuKonteks, dalamOrderFlow, tarikhSekarang, promoAktif);

    var kataJanji = ["kejap","sat","jap","sekejap","nanti","later","dengan anak","dengan suami","dengan isteri","dengan husband","dengan wife","dengan family","dengan mak","dengan ayah","balik rumah","balik kerja","petang","malam","esok","insyaallah","mlm","mlm nanti","malam nanti","petang nanti","esok pagi","kejap lagi","sekejap lagi","nanti ye","nanti saya"];
    if (kataJanji.some(function(k) { return text.toLowerCase().includes(k); })) {
      var adaCODHistory = historyLower.includes("cod") || historyLower.includes("cash on delivery") || historyLower.includes("order_cod");
      if (followUpQueue[phoneNumber].stage === "browsing" && adaCODHistory) { followUpQueue[phoneNumber].stage = "ordered"; followUpQueue[phoneNumber].orderedAt = Date.now(); followUpQueue[phoneNumber].sent3a = false; followUpQueue[phoneNumber].sent3b = false; followUpQueue[phoneNumber].done = false; console.log("COD history detected — stage tukar ordered: " + phoneNumber); }
      else if (followUpQueue[phoneNumber].stage === "browsing") { followUpQueue[phoneNumber].hasJanji = true; followUpQueue[phoneNumber].lastContext = text; followUpQueue[phoneNumber].janjiAt = Date.now(); }
    }

    var kataGambarReal = ["close up","closeup","real","bukan ai","bukan gambar ai","gambar sebenar","gambar real","material kain","texture","close up kain","gambar betul"];
    if (kataGambarReal.some(function(k) { return textLower.includes(k); })) {
      var bajuSkrg = bajuKonteks || getBajuTerakhir(history, products); var warnaSkrg = null;
      products.forEach(function(p) { if (p && p.Warna && history.toLowerCase().includes(p.Warna.toLowerCase())) warnaSkrg = p.Warna; });
      var gambarRealBaju = gambarReal.filter(function(g) {
        if (!g || !g.Nama || !bajuSkrg) return false;
        var namaMatch = g.Nama.toLowerCase().includes(bajuSkrg.toLowerCase());
        if (warnaSkrg && g.Warna) return namaMatch && g.Warna.toLowerCase() === warnaSkrg.toLowerCase();
        return namaMatch;
      });
      var grJawapan = await callClaude(systemPrompt, sesi[phoneNumber], 200);
      grJawapan = sanitizeJawapan(grJawapan);
      sesi[phoneNumber].push({ role: "assistant", content: grJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);
      if (gambarRealBaju.length > 0) { await hantarMesej(phoneNumber, grJawapan); for (var gr = 0; gr < gambarRealBaju.length; gr++) { if (gambarRealBaju[gr].Gambar_URL) { await new Promise(function(r) { setTimeout(r, 1000); }); await hantarGambar(phoneNumber, "😊", gambarRealBaju[gr].Gambar_URL); } } }
      else { await hantarMesej(phoneNumber, grJawapan); }
      return res.sendStatus(200);
    }

    var kataSizeChart = ["size chart","measurement","carta saiz","ukuran baju","size guide","saiz chart","chart size","measurement chart","tgk chart","nk tgk size","nak tgk size","chart","sizing","carta size","tgk carta","tengok carta","nk tgk carta","nak tgk carta","size baju","ukuran size"];
    if (kataSizeChart.some(function(k) { return textLower.includes(k); })) {
      var bajuSC = null; var lastIdxSC = -1;
      sizeChartImages.forEach(function(s) { if (!s || !s.Nama) return; var idx = history.toLowerCase().lastIndexOf(s.Nama.toLowerCase()); if (idx > lastIdxSC) { lastIdxSC = idx; bajuSC = s; } });
      var scJawapan = await callClaude(systemPrompt, sesi[phoneNumber], 200);
      scJawapan = sanitizeJawapan(scJawapan);
      sesi[phoneNumber].push({ role: "assistant", content: scJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);
      if (bajuSC && bajuSC.Gambar_URL) { await hantarGambar(phoneNumber, "Size chart " + bajuSC.Nama + " untuk Cik 😊", bajuSC.Gambar_URL); }
      else { for (var sc = 0; sc < sizeChartImages.length; sc++) { if (sizeChartImages[sc] && sizeChartImages[sc].Gambar_URL) { await hantarGambar(phoneNumber, "Size chart " + sizeChartImages[sc].Nama + " 😊", sizeChartImages[sc].Gambar_URL); await new Promise(function(r) { setTimeout(r, 1000); }); } } }
      await hantarMesej(phoneNumber, scJawapan);
      return res.sendStatus(200);
    }

    var kataKatalog = ["tengok gambar semua","tunjuk semua design","boleh tunjuk koleksi","tengok koleksi","nak tengok semua koleksi","semua design","semua baju","koleksi baju","gambar koleksi","semua koleksi","tunjuk koleksi","gambar semua koleksi","tengok koleksi semua"];
    if (kataKatalog.some(function(k) { return textLower.includes(k); })) {
      var bajuHistoryK = getBajuTerakhir(history, products);
      var katJawapan = await callClaude(systemPrompt, sesi[phoneNumber], 200);
      katJawapan = sanitizeJawapan(katJawapan);
      sesi[phoneNumber].push({ role: "assistant", content: katJawapan });
      await simpanSesi(phoneNumber, sesi[phoneNumber]);
      if (bajuHistoryK) {
        var katalogBajuK = katalog.find(function(k) { return k && k.Nama && (k.Nama.toLowerCase().includes(bajuHistoryK.toLowerCase()) || bajuHistoryK.toLowerCase().includes(k.Nama.toLowerCase())); });
        if (katalogBajuK && katalogBajuK.Gambar_URL) { await hantarGambar(phoneNumber, katJawapan, katalogBajuK.Gambar_URL); } else { await hantarMesej(phoneNumber, katJawapan); }
      } else {
        for (var kat = 0; kat < katalog.length; kat++) { if (katalog[kat] && katalog[kat].Gambar_URL) { await hantarGambar(phoneNumber, katalog[kat].Nama, katalog[kat].Gambar_URL); await new Promise(function(r) { setTimeout(r, 1000); }); } }
        await hantarMesej(phoneNumber, katJawapan);
      }
      return res.sendStatus(200);
    }

    var jawapan = await callClaude(systemPrompt, sesi[phoneNumber], 500);
    jawapan = sanitizeJawapan(jawapan);

    if (jawapan.includes("ORDER_COD_CONFIRMED")) {
      followUpQueue[phoneNumber].stage = "ordered"; followUpQueue[phoneNumber].orderedAt = Date.now(); followUpQueue[phoneNumber].sent3a = false; followUpQueue[phoneNumber].sent3b = false; followUpQueue[phoneNumber].done = false;
      jawapan = jawapan.replace("ORDER_COD_CONFIRMED", "").trim();
      var orderDetails = await extractOrderDetails(history, products);
      followUpQueue[phoneNumber].produk = orderDetails.produk; followUpQueue[phoneNumber].saiz = orderDetails.saiz; followUpQueue[phoneNumber].warna = orderDetails.warna;
      console.log("COD confirmed — order details:", orderDetails);
    }
    if (jawapan.includes("ORDER_RECEIPT_RECEIVED")) { followUpQueue[phoneNumber].stage = "paid"; followUpQueue[phoneNumber].done = true; jawapan = jawapan.replace("ORDER_RECEIPT_RECEIVED", "").trim(); }
    console.log("Jawapan Claude:", jawapan);
    if (jawapan.includes("ORDER_CONFIRMED:")) {
      var orderData = jawapan.split("ORDER_CONFIRMED:")[1].split("|");
      await simpanOrder({ nama: orderData[0]||"", noTel: orderData[1]||"", alamat: orderData[2]||"", poskod: orderData[3]||"", bandar: orderData[4]||"", negeri: orderData[5]||"", produk: orderData[6]||"", saiz: orderData[7]||"", warna: orderData[8]||"", harga: orderData[9]||"", postage: orderData[10]||"", total: orderData[11]||"", kaedahBayar: orderData[12]||"", penamaakaun: orderData[13]||"", nota: orderData[14]||"" });
      jawapan = jawapan.split("ORDER_CONFIRMED:")[0].trim();
      if (!jawapan) jawapan = "Terima kasih Cik! Order Cik telah berjaya disahkan. Kami akan proses segera 😊";
      followUpQueue[phoneNumber].stage = "paid"; followUpQueue[phoneNumber].done = true; followUpQueue[phoneNumber].sent3a = true; followUpQueue[phoneNumber].sent3b = true;
    }

    var buyerPilihQR = ["qr pay","qr code","scan qr","bayar qr","nak qr","pilih qr"].some(function(k) { return text.toLowerCase().includes(k); });
    var textWords = text.toLowerCase().split(/\s+/);
    if (!buyerPilihQR && textWords.indexOf("qr") !== -1) buyerPilihQR = true;

    if (buyerPilihQR && process.env.QR_IMAGE_URL) {
      followUpQueue[phoneNumber].stage = "ordered"; followUpQueue[phoneNumber].orderedAt = Date.now(); followUpQueue[phoneNumber].sent3a = false; followUpQueue[phoneNumber].sent3b = false; followUpQueue[phoneNumber].done = false;
      var qrOrderDetails = await extractOrderDetails(history, products);
      followUpQueue[phoneNumber].produk = qrOrderDetails.produk; followUpQueue[phoneNumber].saiz = qrOrderDetails.saiz; followUpQueue[phoneNumber].warna = qrOrderDetails.warna;
      await hantarMesej(phoneNumber, jawapan); await new Promise(function(r) { setTimeout(r, 1000); }); await hantarGambar(phoneNumber, "Ini QR code untuk pembayaran Cik 😊", process.env.QR_IMAGE_URL);
      sesi[phoneNumber].push({ role: "assistant", content: jawapan }); await simpanSesi(phoneNumber, sesi[phoneNumber]);
      return res.sendStatus(200);
    }

    sesi[phoneNumber].push({ role: "assistant", content: jawapan });
    await simpanSesi(phoneNumber, sesi[phoneNumber]);

    var gambarUrls = await claudeDecideGambar(jawapan, history, products, katalog, sizeChartImages);
    if (gambarUrls.length > 0) { await hantarMesej(phoneNumber, jawapan); for (var gi = 0; gi < gambarUrls.length; gi++) { await new Promise(function(r) { setTimeout(r, 1000); }); await hantarGambar(phoneNumber, "😊", gambarUrls[gi]); } }
    else { await hantarMesej(phoneNumber, jawapan); }

    res.sendStatus(200);
  } catch (err) { console.error(err); res.sendStatus(200); }
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() { console.log("Server running on port " + PORT); });