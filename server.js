const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const claude = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

const VERIFY_TOKEN = "chatbot-baju-token";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const sesi = {};

// Webhook verify
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// Terima mesej
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;
    const text = message?.text?.body;

    if (!message || !text) return res.sendStatus(200);

    if (!sesi[from]) sesi[from] = [];
    sesi[from].push({ role: "user", content: text });

    const systemPrompt = `Kamu adalah pembantu jualan kedai baju Kurung Adel Adyana. 
Jawab dalam Bahasa Malaysia, mesra dan profesional.
Produk:
- Baju Kurung Moden Bella: RM89.90, Saiz XS-XXL, Warna: Putih/Biru Muda/Hijau Mint
- Blouse Raya Sofea: RM65.00, Saiz S-XL, Warna: Merah Marun/Navy/Krem
Postage: Semenanjung RM8, Sabah/Sarawak RM12`;

    try {
      const response = await claude.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: systemPrompt,
        messages: sesi[from]
      });

      const jawapan = response.content[0].text;
      sesi[from].push({ role: "assistant", content: jawapan });

      // Hantar balik ke WhatsApp
      await axios.post(
        https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages,
        {
          messaging_product: "whatsapp",
          to: from,
          text: { body: jawapan }
        },
        {
          headers: { Authorization: Bearer ${WHATSAPP_TOKEN} }
        }
      );

    } catch (err) {
      console.error(err);
    }

    res.sendStatus(200);
  }
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});