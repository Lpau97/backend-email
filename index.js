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

// ------------------------------------
// 🔐 Seguridad por encabezado
// ------------------------------------
const SECRET = process.env.BACKEND_SECRET;

function validar(req, res, next) {
  if (req.headers["x-backend-secret"] !== SECRET) {
    return res.status(401).json({
      ok: false,
      error: "No autorizado"
    });
  }

  next();
}

// ------------------------------------
// 🟦 Supabase
// ------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// ------------------------------------
// 📩 Resend
// ------------------------------------
const resend = new Resend(process.env.RESEND_API_KEY);

// ------------------------------------
// 📌 ENDPOINT 1: CARGAR EXCEL
// ------------------------------------
app.post("/cargar-excel", validar, async (req, res) => {
  try {
    const { excelBase64 } = req.body;

    if (!excelBase64) {
      return res.status(400).json({
        ok: false,
        error: "No se recibió el archivo Excel"
      });
    }

    const buffer = Buffer.from(excelBase64, "base64");

    const workbook = XLSX.read(buffer, {
      type: "buffer"
    });

    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    const data = XLSX.utils.sheet_to_json(sheet);

    const correos = data
      .map((row) => ({
        email: row.email?.toString().trim().toLowerCase(),
        enviado: false,
        procesando: false,
        fecha_envio: null,
        ultimo_intento: null,
        error_envio: null
      }))
      .filter(
        (c) =>
          c.email &&
          c.email.includes("@") &&
          c.email.includes(".")
      );

    if (correos.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No se encontraron correos válidos"
      });
    }

    const { error } = await supabase
      .from("correos")
      .insert(correos);

    if (error) {
      console.error(error);

      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }

    res.json({
      ok: true,
      registros: correos.length
    });
  } catch (err) {
    console.error("ERROR CARGANDO EXCEL:", err);

    res.status(500).json({
      ok: false,
      error: "Error procesando Excel"
    });
  }
});

// ------------------------------------
// 📌 ENDPOINT 2: ESTADO
// ------------------------------------
app.get("/estado", validar, async (req, res) => {
  try {
    const hoy = new Date().toISOString().slice(0, 10);

    const { data: registroHoy } = await supabase
      .from("envios_diarios")
      .select("cantidad")
      .eq("fecha", hoy)
      .maybeSingle();

    const enviadosHoy = registroHoy?.cantidad || 0;

    const { count: total } = await supabase
      .from("correos")
      .select("*", {
        count: "exact",
        head: true
      });

    const { count: enviados } = await supabase
      .from("correos")
      .select("*", {
        count: "exact",
        head: true
      })
      .eq("enviado", true);

    res.json({
      ok: true,
      total,
      enviados,
      enviadosHoy,
      pendientes: total - enviados,
      limite_diario: 200
    });
  } catch (err) {
    console.error("ERROR ESTADO:", err);

    res.status(500).json({
      ok: false,
      error: "Error obteniendo estado"
    });
  }
});

// ------------------------------------
// 📌 ENDPOINT 3: ENVIAR LOTE
// ------------------------------------
app.post("/enviar-lote", validar, async (req, res) => {
  try {
    const { titulo, mensaje, imagenBase64 } = req.body;

    if (!titulo || !mensaje) {
      return res.status(400).json({
        ok: false,
        error: "Faltan datos del correo"
      });
    }

    const hoy = new Date().toISOString().slice(0, 10);

    const LIMITE_DIARIO = 200;

    // --------------------------------
    // 1️⃣ Consultar enviados hoy
    // --------------------------------
    const { data: registroHoy } = await supabase
      .from("envios_diarios")
      .select("cantidad")
      .eq("fecha", hoy)
      .maybeSingle();

    const enviadosHoy = registroHoy?.cantidad || 0;

    if (enviadosHoy >= LIMITE_DIARIO) {
      return res.status(400).json({
        ok: false,
        error: `Límite diario alcanzado (${LIMITE_DIARIO})`
      });
    }

    const disponibles = LIMITE_DIARIO - enviadosHoy;

    // --------------------------------
    // 2️⃣ Obtener pendientes
    // --------------------------------
    const { data: pendientes, error: errorPendientes } =
      await supabase
        .from("correos")
        .select("*")
        .eq("enviado", false)
        .eq("procesando", false)
        .order("id", { ascending: true })
        .limit(disponibles);

    if (errorPendientes) {
      console.error(errorPendientes);

      return res.status(500).json({
        ok: false,
        error: errorPendientes.message
      });
    }

    if (!pendientes || pendientes.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No hay correos pendientes"
      });
    }

    console.log("TOTAL A ENVIAR:", pendientes.length);

    // --------------------------------
    // 3️⃣ Marcar como procesando
    // --------------------------------
    const ids = pendientes.map((x) => x.id);

    await supabase
      .from("correos")
      .update({
        procesando: true
      })
      .in("id", ids);

    // --------------------------------
    // 4️⃣ Envío secuencial
    // --------------------------------
    let enviados = 0;

    for (const item of pendientes) {
      try {
        console.log("Enviando a:", item.email);

        const response = await resend.emails.send({
          from: `Curso de Seguros <ventas@${process.env.RESEND_DOMAIN}>`,
          reply_to: `scardoso@${process.env.RESEND_DOMAIN}`,
          to: item.email,
          subject: titulo,
          html: mensaje,
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

        console.log("RESPUESTA RESEND:", response);

        // ✅ Éxito
        if (response?.data?.id) {
          await supabase
            .from("correos")
            .update({
              enviado: true,
              procesando: false,
              fecha_envio: new Date().toISOString(),
              ultimo_intento: new Date().toISOString(),
              error_envio: null
            })
            .eq("id", item.id);

          enviados++;

          console.log("✅ Enviado:", item.email);
        } else {
          // ❌ Error controlado
          await supabase
            .from("correos")
            .update({
              procesando: false,
              ultimo_intento: new Date().toISOString(),
              error_envio:
                response?.error?.message ||
                "Error desconocido"
            })
            .eq("id", item.id);

          console.log(
            "❌ Falló:",
            item.email,
            response?.error
          );
        }

        // ⏳ Espera para evitar rate limit
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        console.error(
          "❌ ERROR ENVIANDO A:",
          item.email
        );

        console.error(
          JSON.stringify(err, null, 2)
        );

        await supabase
          .from("correos")
          .update({
            procesando: false,
            ultimo_intento: new Date().toISOString(),
            error_envio: err.message
          })
          .eq("id", item.id);
      }
    }

    // --------------------------------
    // 5️⃣ Actualizar contador diario
    // --------------------------------
    if (registroHoy) {
      await supabase
        .from("envios_diarios")
        .update({
          cantidad: enviadosHoy + enviados
        })
        .eq("fecha", hoy);
    } else {
      await supabase
        .from("envios_diarios")
        .insert({
          fecha: hoy,
          cantidad: enviados
        });
    }

    // --------------------------------
    // 6️⃣ Contar restantes
    // --------------------------------
    const { count: restantes } = await supabase
      .from("correos")
      .select("*", {
        count: "exact",
        head: true
      })
      .eq("enviado", false);

    res.json({
      ok: true,
      enviadosHoy: enviadosHoy + enviados,
      enviadosEnEstaCampaña: enviados,
      restantes
    });
  } catch (err) {
    console.error("ERROR GENERAL:", err);

    res.status(500).json({
      ok: false,
      error: "Error en envío masivo"
    });
  }
});

// ------------------------------------
// 📌 ENDPOINT: LISTAR CORREOS
// ------------------------------------
app.get("/correos", validar, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("correos")
      .select("*")
      .order("id", {
        ascending: true
      });

    if (error) {
      console.error(error);

      return res.status(500).json({
        ok: false,
        correos: []
      });
    }

    res.json({
      ok: true,
      correos: data
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      ok: false,
      error: "Error obteniendo correos"
    });
  }
});

// ------------------------------------
// 🚀 SERVIDOR
// ------------------------------------
app.listen(process.env.PORT, () => {
  console.log(
    "✅ Backend corriendo en puerto",
    process.env.PORT
  );
});
