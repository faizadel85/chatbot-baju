const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const claude = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const VERIFY_TOKEN = "chatbot-baju-token";
const sesi = {};

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

    var message = body.entry[0].changes[0].value.messages[0];
    var from = message.from;
    var text = message.text.body;

    if (!sesi[from]) sesi[from] = [];
    sesi[from].push({ role: "user", content: text });

    var systemPrompt = "Kamu adalah pembantu jualan kedai baju Kurung Adel Adyana. Jawab dalam Bahasa Malaysia, mesra dan profesional. Produk: Baju Kurung Moden Bella RM89.90 Saiz XS-XXL Warna Putih/Biru Muda/Hijau Mint. Blouse Raya Sofea RM65.00 Saiz S-XL Warna Merah Marun/Navy/Krem. Postage Semenanjung RM8 Sabah/Sarawak RM12.";

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