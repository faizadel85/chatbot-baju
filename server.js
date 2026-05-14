const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const WASSENGER_TOKEN = process.env.WASSENGER_TOKEN;
const sesi = {};

async function getSheetData(sheetName) {
  var SHEET_ID = "1lz5K8te2CihyjBcHht4FH4j21Sir1EzNwapGlIQfvb8";
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
  return "Kamu adalah pembantu jualan kedai baju ADEL Adyana Elegance. Jawab dalam Bahasa Malaysia yang mesra dan mudah difahami.\n\n" +
    "PRODUK:\n" + senaraiProduk + "\n\n" +
    "PANDUAN SAIZ:\n" + sizeText + "\n\n" +
    "DETAIL PRODUK:\n" + detailText + "\n\n" +
    "PERATURAN:\n" +
    "- Tanya berat badan dan ukuran dada untuk recommend saiz\n" +
    "- Jika stok = 0, beritahu HABIS STOK\n" +
    "- Saiz 3XL dan 4XL ada tambahan RM10\n" +
    "- Minta nama penuh, alamat dan no telefon untuk order\n" +
    "- Postage: Semenanjung RM8, Sabah/Sarawak RM12";
}

app.post("/webhook", async function(req, res) {
  try {
    var data = req.body;

    // Wassenger webhook format
    if (data.event !== "message:in:new") return res.sendStatus(200);
    if (data.data.fromMe) return res.sendStatus(200);

    var from = data.data.chatId || data.data.from || "";
    var text = data.data.body || data.data.text || "";

    if (!from || !text) return res.sendStatus(200);

   // Buang @c.us
   var phoneNumber = from.replace("@c.us", "").replace("@s.whatsapp.net", "");

    if (!text) return res.sendStatus(200);

    if (!sesi[from]) sesi[from] = [];
    sesi[from].push({ role: "user", content: text });

    var products = await getSheetData("Sheet1");
    var sizeChart = await getSheetData("Size Chart");
    var produkDetail = await getSheetData("produkDetail");
    var systemPrompt = buatSystemPrompt(products, sizeChart, produkDetail);

    var response = await claude.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      system: systemPrompt,
      messages: sesi[from]
    });

    var jawapan = response.content[0].text;
    sesi[from].push({ role: "assistant", content: jawapan });

    // Hantar balik guna Wassenger API
    // Cari gambar berdasarkan produk yang dibincangkan
var gambarUrl = null;
products.forEach(function(p) {
  if (jawapan.toLowerCase().includes(p.Warna.toLowerCase()) && 
      jawapan.toLowerCase().includes(p.Nama.toLowerCase()) &&
      p.Gambar_URL) {
    gambarUrl = p.Gambar_URL;
  }
});

// Hantar gambar kalau ada
if (gambarUrl) {
  await axios.post(
    "https://api.wassenger.com/v1/messages",
    { 
      phone: phoneNumber, 
      message: jawapan,
      media: { url: gambarUrl }
    },
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