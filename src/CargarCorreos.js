import { useState } from "react";
import { Upload, Button, message, Card } from "antd";
import { UploadOutlined } from "@ant-design/icons";

function CargarCorreos() {
  const [file, setFile] = useState(null);

  const beforeUpload = (file) => {
    setFile(file);
    return false;
  };

  const handleUpload = async () => {
    if (!file) return message.error("Selecciona un archivo Excel");

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(",")[1];

      const resp = await fetch("http://localhost:4000/cargar-excel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excelBase64: base64 })
      });

      const data = await resp.json();
      if (data.ok) {
        message.success(`Correos cargados: ${data.registros}`);
      } else {
        message.error("Error cargando correos");
      }
    };

    reader.readAsDataURL(file);
  };

  return (
    <Card title="Cargar Excel de Correos" style={{ maxWidth: 500, margin: "20px auto" }}>
      <Upload beforeUpload={beforeUpload} maxCount={1}>
        <Button icon={<UploadOutlined />}>Seleccionar Excel</Button>
      </Upload>

      <Button
        type="primary"
        onClick={handleUpload}
        style={{ marginTop: 15 }}
      >
        Subir Correos
      </Button>
    </Card>
  );
}

export default CargarCorreos;
