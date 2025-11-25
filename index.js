import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import * as XLSX from "xlsx";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Seguridad
const SECRET = process.env.BACKEND_SECRET;

function validar(req, res, next) {
  if (req.headers["x-backend-secret"] !== SECRET) {
    return res.status(401).json({ ok: false, error: "No autorizado" });
  }
  next();
}

// Transportador de Gmail
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

// Leer correos
function cargarCorreos() {
  try {
    return JSON.parse(fs.readFileSync("correos.json"));
  } catch {
    return [];
  }
}

// Guardar correos
function guardarCorreos(data) {
  fs.writeFileSync("correos.json", JSON.stringify(data, null, 2));
}

// ---------- ENDPOINT 1: Cargar Excel ----------
app.post("/cargar-excel", validar, (req, res) => {
  try {
    const { excelBase64 } = req.body;

    const buffer = Buffer.from(excelBase64, "base64");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    const correos = data.map((row) => ({
      email: row.email,
      enviado: false
    }));

    guardarCorreos(correos);

    res.json({ ok: true, registros: correos.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Error leyendo Excel" });
  }
});

// ---------- ENDPOINT 2: Estado ----------
app.get("/estado", validar, (req, res) => {
  const lista = cargarCorreos();
  const enviados = lista.filter(x => x.enviado).length;
  const pendientes = lista.length - enviados;

  res.json({
    total: lista.length,
    enviados,
    pendientes
  });
});
app.get("/correos", (req, res) => {
  try {
    const lista = JSON.parse(fs.readFileSync("correos.json"));
    res.json({ ok: true, correos: lista });
  } catch {
    res.json({ ok: false, correos: [] });
  }
});

// ---------- ENDPOINT 3: Enviar correos por lote ----------
app.post("/enviar-lote", validar, async (req, res) => {
  const { titulo, mensaje } = req.body;

  let lista = cargarCorreos();
  const pendientes = lista.filter((x) => !x.enviado).slice(0, 400);

  let enviados = 0;

  for (let item of pendientes) {
    try {
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: item.email,
        subject: titulo,
        html: `<p>${mensaje}</p>`
      });

      item.enviado = true;
      enviados++;

      console.log("Enviado a:", item.email);

      // Espera para evitar bloqueo
      await new Promise((r) => setTimeout(r, 800));

    } catch (err) {
      console.log("Error enviando a:", item.email, err.message);
    }
  }

  guardarCorreos(lista);

  res.json({
    ok: true,
    enviadosHoy: enviados,
    restantes: lista.filter((x) => !x.enviado).length
  });
});

// ---------- Servidor ----------
app.listen(process.env.PORT, () =>
  console.log("Backend corriendo en puerto", process.env.PORT)
);
