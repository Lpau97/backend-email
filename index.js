import express from "express";
import cors from "cors";
import * as XLSX from "xlsx";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ------------------------------
// 🔐 Seguridad por encabezado
// ------------------------------
const SECRET = process.env.BACKEND_SECRET;

function validar(req, res, next) {
  if (req.headers["x-backend-secret"] !== SECRET) {
    return res.status(401).json({ ok: false, error: "No autorizado" });
  }
  next();
}

// ------------------------------
// 🟦 Conexión a Supabase
// ------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// ------------------------------
// 📩 Cliente Resend
// ------------------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// ------------------------------
// 📌 ENDPOINT 1: CARGAR EXCEL
// ------------------------------
app.post("/cargar-excel", validar, async (req, res) => {
  try {
    const { excelBase64 } = req.body;

    const buffer = Buffer.from(excelBase64, "base64");
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    const correos = data
      .map((row) => ({
        email: row.email?.toString().trim(),
        enviado: false,
        fecha_envio: null
      }))
      .filter((c) => c.email && c.email.includes("@"));

    if (correos.length === 0)
      return res.json({ ok: false, error: "No se encontraron correos válidos." });

    const { error } = await supabase.from("correos").insert(correos);
    if (error) throw error;

    res.json({ ok: true, registros: correos.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error guardando correos" });
  }
});

// ------------------------------
// 📌 ENDPOINT 2: ESTADO
// ------------------------------
app.get("/estado", validar, async (req, res) => {
  const hoy = new Date().toISOString().slice(0, 10);

  const { data: registroHoy } = await supabase
    .from("envios_diarios")
    .select("cantidad")
    .eq("fecha", hoy)
    .single();

  const enviadosHoy = registroHoy?.cantidad || 0;

  const { count: total } = await supabase
    .from("correos")
    .select("*", { count: "exact", head: true });

  const { count: enviados } = await supabase
    .from("correos")
    .select("*", { count: "exact", head: true })
    .eq("enviado", true);

  res.json({
    total,
    enviados,
    enviadosHoy,
    pendientes: total - enviados,
    limite_diario: 80
  });
});

// ------------------------------
// 📌 ENDPOINT 3: ENVIAR LOTE (con límite diario)
// ------------------------------
app.post("/enviar-lote", validar, async (req, res) => {
  const { titulo, mensaje } = req.body;
  const hoy = new Date().toISOString().slice(0, 10);
  const LIMITE = 80;

  try {
    // 1️⃣ Consultar cuántos se han enviado hoy
    const { data: registroHoy } = await supabase
      .from("envios_diarios")
      .select("cantidad")
      .eq("fecha", hoy)
      .single();

    const enviadosHoy = registroHoy?.cantidad || 0;

    if (enviadosHoy >= LIMITE) {
      return res.json({
        ok: false,
        error: `Límite diario alcanzado (${LIMITE})`
      });
    }

    const disponibles = LIMITE - enviadosHoy;

    // 2️⃣ Obtener correos pendientes (solo lo permitido por el límite)
    const { data: pendientes } = await supabase
      .from("correos")
      .select("*")
      .eq("enviado", false)
      .limit(disponibles);

    if (!pendientes || pendientes.length === 0) {
      return res.json({ ok: false, error: "No hay correos pendientes" });
    }

    let enviados = 0;

    // 3️⃣ Envío secuencial
    for (let item of pendientes) {
      try {
        await resend.emails.send({
          from: `Noticias <no-reply@${process.env.RESEND_DOMAIN}>`,
          to: item.email,
          subject: titulo,
          html: mensaje,
          attachments: req.body.imagenBase64
            ? [
                {
                  filename: "imagen.jpg",
                  content: req.body.imagenBase64.split(",")[1], // Remover "data:image/jpeg;base64,"
                  type: "image/jpeg",
                  disposition: "inline",
                  content_id: "imagen1" // Debe coincidir con cid:imagen1
                }
              ]
            : []
        });

        await supabase
          .from("correos")
          .update({
            enviado: true,
            fecha_envio: new Date().toISOString()
          })
          .eq("id", item.id);

        enviados++;

        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.log("Error enviando a:", item.email, err);
      }
    }

    // 4️⃣ Actualizar contador diario
    if (registroHoy) {
      await supabase
        .from("envios_diarios")
        .update({ cantidad: enviadosHoy + enviados })
        .eq("fecha", hoy);
    } else {
      await supabase
        .from("envios_diarios")
        .insert({ fecha: hoy, cantidad: enviados });
    }

    const { count: restantes } = await supabase
      .from("correos")
      .select("*", { count: "exact", head: true })
      .eq("enviado", false);

    res.json({
      ok: true,
      enviadosHoy: enviadosHoy + enviados,
      enviadosEnEstaCampaña: enviados,
      restantes
    });
  } catch (err) {
    console.error("Error en enviar-lote:", err);
    res.status(500).json({ ok: false, error: "Error en envío masivo" });
  }
});

// ------------------------------
// 📌 ENDPOINT: LISTAR CORREOS
// ------------------------------
app.get("/correos", validar, async (req, res) => {
  const { data, error } = await supabase.from("correos").select("*");

  if (error) return res.json({ ok: false, correos: [] });

  res.json({ ok: true, correos: data });
});

// ------------------------------
// 🚀 Servidor
// ------------------------------
app.listen(process.env.PORT, () =>
  console.log("Backend corriendo en puerto", process.env.PORT)
);
