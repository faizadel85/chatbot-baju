const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const VERIFY_TOKEN = "chatbot-baju-token";
const SHEET_ID = "1lz5K8te2CihyjBcHht4FH4j21Sir1EzNwapGlIQfvb8";
const sesi = {};

async function getInventory() {
  try {
    var url = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/gviz/tq?tqx=out:csv";
    var response = await axios.get(url);
    var lines = response.data.split("\n");
    var headers = lines[0].split(",").map(function(h) { return h.replace(/"/g, "").trim(); });
    var products = [];
    for (var i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var values = lines[i].split(",").map(function(v) { return v.replace(/"/g, "").trim(); });
      var product = {};
      for (var j = 0; j < headers.length; j++) {
        product[headers[j]] = values[j] || "";
      }
      products.push(product);
    }
    return products;
  } catch (err) {
    console.error("Sheet error:", err);
    return [];
  }
}

function buatSystemPrompt(products) {
  var senarai = products.map(function(p) {
    return p.Nama + " | Warna: " + p.Warna +
      " | Harga XS-2XL: RM" + p.Harga_XS_2XL +
      " | Harga 3XL-4XL: RM" + p.Harga_3XL_4XL +
      " | Stok: XS=" + p.Stock_XS +
      " S=" + p.Stock_S +
      " M=" + p.Stock_M +
      " L=" + p.Stock_L +
      " XL=" + p.Stock_XL +
      " 2XL=" + p.Stock_2XL +
      " 3XL=" + p.Stock_3XL +
      " 4XL=" + p.Stock_4XL;
  }).join("\n");

  return "Kamu adalah pembantu jualan kedai baju Kurung Adel Adyana. Jawab dalam Bahasa Malaysia, mesra dan profesional.\n\nSenarai produk terkini:\n" + senarai + "\n\nPeraturan:\n- Jika stok = 0, beritahu HABIS STOK\n- Tanya saiz & warna sebelum confirm order\n- Harga 3XL & 4XL lebih mahal\n- Jika nak order, minta nama, alamat & no telefon\n- Postage: Semenanjung RM8, Sabah/Sarawak RM12";
}

app.get("/webhook", function(req, res) {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async function(req, res) {
  try {
    var body = req.body;
    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    var entry = body.entry[0];
    var changes = entry.changes[0];
    var value = changes.value;

    if (!value.messages) return res.sendStatus(200);

    var message = value.messages[0];
    var from = message.from;
    var text = message.text ? message.text.body : null;

    if (!text) return res.sendStatus(200);

    if (!sesi[from]) sesi[from] = [];
    sesi[from].push({ role: "user", content: text });

    var products = await getInventory();
    var systemPrompt = buatSystemPrompt(products);

    var response = await claude.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      system: systemPrompt,
      messages: sesi[from]
    });

    var jawapan = response.content[0].text;
    sesi[from].push({ role: "assistant", content: jawapan });

    var phoneId = process.env.PHONE_NUMBER_ID;
    var token = process.env.WHATSAPP_TOKEN;

    await axios.post(
      "https://graph.facebook.com/v18.0/" + phoneId + "/messages",
      { messaging_product: "whatsapp", to: from, text: { body: jawapan } },
      { headers: { Authorization: "Bearer " + token } }
    );

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