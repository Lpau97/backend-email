import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import * as XLSX from "xlsx";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

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

// Conexión a Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Transportador de Gmail
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

// ---------- ENDPOINT 1: Cargar Excel ----------
app.post("/cargar-excel", validar, async (req, res) => {
  try {
    const { excelBase64 } = req.body;

    const buffer = Buffer.from(excelBase64, "base64");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    const correos = data.map((row) => ({
      email: row.email,
      enviado: false,
      fecha_envio: null
    }));

    const { error } = await supabase.from("correos").insert(correos);

    if (error) throw error;

    res.json({ ok: true, registros: correos.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error guardando en Supabase" });
  }
});

// ---------- ENDPOINT 2: Estado ----------
app.get("/estado", validar, async (req, res) => {
  const { count: total } = await supabase
    .from("correos")
    .select("*", { count: "exact", head: true });

  const { count: enviados } = await supabase
    .from("correos")
    .select("*", { count: "exact", head: true })
    .eq("enviado", true);

  const pendientes = total - enviados;

  res.json({
    total,
    enviados,
    pendientes
  });
});

// ---------- ENDPOINT 3: Enviar correos por lote ----------
app.post("/enviar-lote", validar, async (req, res) => {
  const { titulo, mensaje } = req.body;

  const { data: pendientes } = await supabase
    .from("correos")
    .select("*")
    .eq("enviado", false)
    .limit(400);

  let enviados = 0;

  for (let item of pendientes) {
    try {
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: item.email,
        subject: titulo,
        html: `<p>${mensaje}</p>`
      });

      await supabase
        .from("correos")
        .update({
          enviado: true,
          fecha_envio: new Date().toISOString()
        })
        .eq("id", item.id);

      enviados++;
      await new Promise((r) => setTimeout(r, 800));

    } catch (err) {
      console.log("Error enviando a:", item.email, err.message);
    }
  }

  const { count: restantes } = await supabase
    .from("correos")
    .select("*", { count: "exact", head: true })
    .eq("enviado", false);

  res.json({
    ok: true,
    enviadosHoy: enviados,
    restantes
  });
});

// ---------- Listado de correos ----------
app.get("/correos", async (req, res) => {
  const { data, error } = await supabase.from("correos").select("*");

  if (error) return res.json({ ok: false, correos: [] });

  res.json({ ok: true, correos: data });
});

// ---------- Servidor ----------
app.listen(process.env.PORT, () =>
  console.log("Backend corriendo en puerto", process.env.PORT)
);
