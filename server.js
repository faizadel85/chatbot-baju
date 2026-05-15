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

    // Cari row sedia ada
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
    var messagesJson = JSON.stringify(messages.slice(-20)); // Simpan 20 mesej terakhir

    if (rowIndex > 0) {
      // Update row sedia ada
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: "Sessions!A" + rowIndex + ":C" + rowIndex,
        valueInputOption: "RAW",
        resource: { values: [[phoneNumber, now, messagesJson]] }
      });
    } else {
      // Tambah row baru
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
        // Semak kalau sesi lebih 24 jam — reset
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
      range: "Orders!A:M",
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
          "Baru",
          data.nota || ""
        ]]
      }
    });
    console.log("Order disimpan!");
  } catch (err) {
    console.error("Error simpan order:", err);
  }
}

// ===== FOLLOW UP =====
var followUpQueue = {};

var MSG_FOLLOWUP_1 = "Assalamualaikum 🫶🏻, Cik cari size dan warna apa ya?\n\nAtau nak saya bantu dapatkan size yg sesuai untuk Cik?🥰";

var MSG_FOLLOWUP_2 = "Assalamualaikum! Semoga Cik dalam keadaan baik & semoga urusan kita sama² dipermudahkan hari ini 😊\n\nCik ada tekan link iklan saya dari FB/IG. Saya sangat-sangat hargai respon Cik 💕\n\nCik tengah cari warna dan size apa ya? Ada apa boleh saya bantu?";

var FOLLOWUP_1_MS = 60 * 60 * 1000;
var FOLLOWUP_2_MS = 24 * 60 * 60 * 1000;

async function hantarFollowUp(phoneNumber, mesej) {
  try {
    await axios.post(
      "https://api.wassenger.com/v1/messages",
      { phone: phoneNumber, message: mesej },
      { headers: { Token: WASSENGER_TOKEN } }
    );
    console.log("Follow up dihantar ke: " + phoneNumber);
  } catch (err) {
    console.error("Error follow up:", err);
  }
}

setInterval(async function() {
  var now = Date.now();
  for (var phone in followUpQueue) {
    var q = followUpQueue[phone];
    if (q.done) continue;
    if (!q.sent1 && (now - q.lastReply) >= FOLLOWUP_1_MS) {
      await hantarFollowUp(phone, MSG_FOLLOWUP_1);
      followUpQueue[phone].sent1 = true;
    }
    if (q.sent1 && !q.sent2 && (now - q.lastReply) >= FOLLOWUP_2_MS) {
      await hantarFollowUp(phone, MSG_FOLLOWUP_2);
      followUpQueue[phone].sent2 = true;
      followUpQueue[phone].done = true;
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

  var sizeText = "Panduan Saiz Baju Kurung Neesya:\n";
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

  return "Kamu adalah pembantu jualan kedai baju ADEL Adyana Elegance. Jawab dalam Bahasa Malaysia yang mesra dan mudah difahami.\n" +
    "PENTING: Sentiasa panggil pelanggan sebagai 'Cik' — JANGAN guna 'akak', 'awak', 'kakak' atau panggilan lain.\n\n" +
    "PRODUK:\n" + senaraiProduk + "\n\n" +
    "PANDUAN SAIZ:\n" + sizeText + "\n\n" +
    "DETAIL PRODUK:\n" + detailText + "\n\n" +
    "PERATURAN:\n" +
    "- Tanya berat badan dan ukuran dada untuk recommend saiz\n" +
    "- Jika stok = 0, beritahu HABIS STOK\n" +
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
    "- Kamu BOLEH hantar gambar produk — sistem akan hantar gambar automatik\n" +
    "- Jika pelanggan tanya gambar, jawab: 'Ini gambar [nama baju] warna [warna] untuk Cik 😊'\n" +
    "- LARANGAN MUTLAK: JANGAN tulis perkataan 'sistem', 'akan hantar', 'gambar akan', kurungan [ ] dalam jawapan\n" +
    "- LARANGAN MUTLAK: JANGAN explain cara gambar dihantar\n" +
    "- Jawapan kepada soalan gambar mestilah ayat biasa sahaja\n" +
    "- Flow order yang BETUL:\n" +
    "  1. Pelanggan confirm nak beli\n" +
    "  2. Tanya lokasi penghantaran: Semenanjung atau Sabah/Sarawak\n" +
    "  3. Kira dan beritahu jumlah postage berdasarkan lokasi dan bilangan pcs\n" +
    "  4. Tanya kaedah pembayaran: Bank Transfer atau COD\n" +
    "  5. Bagi info pembayaran dengan jumlah total (harga + postage)\n" +
    "  6. Tunggu pelanggan hantar resit/bukti bayar\n" +
    "  7. Bila pelanggan hantar resit, minta details penghantaran (nama, no telefon, alamat, poskod, bandar, negeri)\n" +
    "  8. Bila semua details lengkap, tulis: ORDER_CONFIRMED:nama|notel|alamat|poskod|bandar|negeri|produk|saiz|warna|harga|nota\n" +
    "- JANGAN minta details penghantaran sebelum pelanggan hantar resit\n" +
    "- Bila pelanggan bagi details penghantaran, JANGAN tanya semula produk\n" +
    "- Jika pelanggan tanya size chart, jawab HANYA dengan ayat pendek: 'Ini size chart untuk [nama baju] 😊'\n" +
    "- JANGAN guna markdown, JANGAN tulis URL dalam teks jawapan\n" +
    "- Jawapan mesti dalam teks biasa sahaja";
}

// ===== WEBHOOK =====
app.post("/webhook", async function(req, res) {
  try {
    var data = req.body;

    if (data.event !== "message:in:new") return res.sendStatus(200);
    if (data.data.fromMe) return res.sendStatus(200);

    var from = data.data.chatId || data.data.from || "";
    var text = data.data.body || data.data.text || "";

    if (!from || !text) return res.sendStatus(200);

    var phoneNumber = from.replace("@c.us", "").replace("@s.whatsapp.net", "");

    // Reset follow up
    followUpQueue[phoneNumber] = {
      lastReply: Date.now(),
      sent1: false,
      sent2: false,
      done: false
    };

    // Load sesi dari Google Sheet
    if (!sesi[phoneNumber]) {
      sesi[phoneNumber] = await loadSesi(phoneNumber);
    }

    sesi[phoneNumber].push({ role: "user", content: text });

    var products = await getSheetDataCached("Sheet1");
    var sizeChart = await getSheetDataCached("Size Chart");
    var produkDetail = await getSheetDataCached("produkDetail");
    var sizeChartImages = await getSheetDataCached("sizeChartImages");
    var systemPrompt = buatSystemPrompt(products, sizeChart, produkDetail, sizeChartImages);

    // Retry 3 kali kalau overloaded
    var response;
    var cuba = 0;
    while (cuba < 3) {
      try {
        response = await claude.messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: 500,
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

    // Simpan sesi ke Google Sheet
    await simpanSesi(phoneNumber, sesi[phoneNumber]);

    // Detect dan simpan order
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
        nota: orderData[10] || ""
      });
      jawapan = jawapan.split("ORDER_CONFIRMED:")[0].trim();
      if (!jawapan) {
        jawapan = "Terima kasih Cik! Order Cik telah berjaya direkodkan. Kami akan proses segera dan maklumkan status penghantaran. 😊";
      }
    }

    // Detect gambar produk
    var gambarUrl = null;
    products.forEach(function(p) {
      if (jawapan.toLowerCase().includes(p.Warna.toLowerCase()) &&
          jawapan.toLowerCase().includes(p.Nama.toLowerCase()) &&
          p.Gambar_URL) {
        gambarUrl = p.Gambar_URL;
      }
    });

    // Detect size chart
    var kataSizeChart = ["size chart", "carta saiz", "ukuran baju", "size guide"];
    var tanyaSizeChart = kataSizeChart.some(function(kata) {
      return text.toLowerCase().includes(kata);
    });

    if (tanyaSizeChart) {
      sizeChartImages.forEach(function(s) {
        if (jawapan.toLowerCase().includes(s.Nama.toLowerCase()) && s.Gambar_URL) {
          gambarUrl = s.Gambar_URL;
        }
      });
    }

    // Hantar mesej
    if (gambarUrl) {
      await axios.post(
        "https://api.wassenger.com/v1/messages",
        { phone: phoneNumber, message: jawapan, media: { url: gambarUrl } },
        { headers: { Token: WASSENGER_TOKEN } }
      );
    } else {
      await axios.post(
        "https://api.wassenger.com/v1/messages",
        { phone: phoneNumber, message: jawapan },
        { headers: { Token: WASSENGER_TOKEN } }
      );
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