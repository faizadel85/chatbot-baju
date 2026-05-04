const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.urlencoded({ extended: true }));

const claude = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

const products = [
  {
    nama: "Baju Kurung Moden Bella",
    harga: 89.90,
    saiz: ["XS", "S", "M", "L", "XL", "XXL"],
    stok: { XS: 3, S: 10, M: 15, L: 8, XL: 5, XXL: 2 },
    warna: ["Putih", "Biru Muda", "Hijau Mint"]
  },
  {
    nama: "Blouse Raya Sofea",
    harga: 65.00,
    saiz: ["S", "M", "L", "XL"],
    stok: { S: 0, M: 7, L: 12, XL: 4 },
    warna: ["Merah Marun", "Navy", "Krem"]
  }
];

const sesi = {};

app.post("/webhook", async function(req, res) {
  var mesej = req.body.Body;
  var noPhone = req.body.From;

  if (!sesi[noPhone]) {
    sesi[noPhone] = [];
  }

  sesi[noPhone].push({ role: "user", content: mesej });

  var senaraiProduk = products.map(function(p) {
    return "Nama: " + p.nama + " | Harga: RM" + p.harga + " | Saiz: " + p.saiz.join(",") + " | Stok: " + JSON.stringify(p.stok) + " | Warna: " + p.warna.join(",");
  }).join("\n");

  var systemPrompt = "Kamu adalah pembantu jualan kedai baju. Jawab dalam Bahasa Malaysia, mesra dan profesional.\nSenarai produk:\n" + senaraiProduk + "\n\nPeraturan:\n- Jika stok = 0, beritahu HABIS STOK\n- Tanya saiz & warna sebelum confirm order\n- Jika nak order, minta nama, alamat & no telefon\n- Postage: Semenanjung RM8, Sabah/Sarawak RM12";

  try {
    var response = await claude.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      system: systemPrompt,
      messages: sesi[noPhone]
    });

    var jawapan = response.content[0].text;
    sesi[noPhone].push({ role: "assistant", content: jawapan });

    var twiml = new twilio.twiml.MessagingResponse();
    twiml.message(jawapan);
    res.type("text/xml").send(twiml.toString());

  } catch (err) {
    console.error(err);
    var twiml2 = new twilio.twiml.MessagingResponse();
    twiml2.message("Maaf, ada masalah teknikal. Cuba lagi.");
    res.type("text/xml").send(twiml2.toString());
  }
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});