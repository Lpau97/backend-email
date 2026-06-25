import express from "express";
import cors from "cors";
import * as XLSX from "xlsx";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import { BrevoClient } from "@getbrevo/brevo";
import formData from "form-data";
import Mailgun from "mailgun.js";


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
// 📩 Cliente Resend , Brevo y Mailgun
// ------------------------------
const resend = new Resend(process.env.RESEND_API_KEY);
const brevo = new BrevoClient({
  apiKey: process.env.BREVO_API_KEY
});

const mailgun = new Mailgun(formData);
const mg = mailgun.client({
  username: "api",
  key: process.env.MAILGUN_API_KEY,
});


async function enviarEmail({
  to,
  subject,
  html,
  imagenBase64
}){
  
  // ---------- RESEND ----------
  try {
    const response = await resend.emails.send({
      from: `Curso de Seguros <ventas@${process.env.RESEND_DOMAIN}>`,
      reply_to: `scardoso@${process.env.RESEND_DOMAIN}`,
      to,
      subject,
      html,
      text: "Información sobre el Curso de Seguros",

      attachments:
        imagenBase64 &&
        imagenBase64.includes(",")
          ? [
              {
                filename: "imagen.jpg",
                content: imagenBase64.split(",")[1],
                type: "image/jpeg",
                disposition: "inline",
                content_id: "imagen1"
              }
            ]
          : []
    });

    if (response?.data?.id) {
      console.log(`✅ Resend -> ${to}`);
      return {
        ok: true,
        proveedor: "resend"
      };
    }

    throw new Error("Resend no devolvió ID");
  } catch (err) {
    console.log(
      `⚠️ Resend falló para ${to}. Intentando Brevo...`
    );
  }

   // ---------- 3. MAILGUN ----------
 try {
   const attachments =
    imagenBase64 && imagenBase64.includes(",")
      ? [
          {
            filename: "insurance-ecuador.jpg",
            data: Buffer.from(imagenBase64.split(",")[1], "base64")
          }
        ]
      : [];
    await mg.messages.create(process.env.MAILGUN_DOMAIN, {
      from: `Curso de Seguros <${process.env.MAILGUN_FROM_EMAIL}>`,
      to,
      subject, 
      html,
      attachment: attachments
    
  });

    return { ok: true, proveedor: "mailgun" };

  } catch (err) {
    console.log("Mailgun falló también");

    return {
      ok: false,
      proveedor: null,
      error: err.message
    };
  }


  // ---------- BREVO ----------
  try {
    const attachments =
    imagenBase64 && imagenBase64.includes(",")
      ? [
          {
            name: "imagen.jpg",
            content: imagenBase64.split(",")[1]
          }
        ]
      : [];
    await brevo.transactionalEmails.sendTransacEmail({
      sender: {
        name: "Curso de Seguros",
        email: process.env.BREVO_FROM_EMAIL
      },

      to: [
        {
          email: to
        }
      ],

      subject,
      htmlContent: `
      ${html}
      ${
        imagenBase64
          ? `<br><img src="https://via.placeholder.com/600x300" style="max-width:100%;" />`
          : ""
      }
    `,
    textContent: "Información sobre el Curso de Seguros",

    attachment: attachments
  });
    
    console.log(`✅ Brevo -> ${to}`);

    return {
      ok: true,
      proveedor: "brevo"
    };
  } catch (err) {
    console.log(`❌ Brevo también falló para ${to}`);

    return {
      ok: false,
      proveedor: null,
      error: err.message
    };
  }
  
 

}

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
    limite_diario: 500
  });
});

// ------------------------------
// 📌 ENDPOINT 3: ENVIAR LOTE (con límite diario)
// ------------------------------
app.post("/enviar-lote", validar, async (req, res) => {
  const { titulo, mensaje } = req.body;
  const hoy = new Date().toISOString().slice(0, 10);
  const LIMITE = 500;

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
    
        const resultado = await enviarEmail({
        to: item.email,
        subject: titulo,
        html: mensaje,
        imagenBase64: req.body.imagenBase64
      });

      if (resultado.ok) {
        await supabase
          .from("correos")
          .update({
            enviado: true,
            fecha_envio: new Date().toISOString()
          })
          .eq("id", item.id);

        enviados++;

        console.log(
          `Enviado correctamente a ${item.email} usando ${resultado.proveedor}`
        );
      } else {
        console.log(
          `Error enviando a ${item.email}:`,
          resultado.error
        );
        }
    
        // ✅ SOLO marcar como enviado si Resend respondió correctamente
       
    
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
