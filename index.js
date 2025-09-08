// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

// primary printer libs
const pdfPrinter = require("pdf-to-printer");
const ipp = require("ipp");
const net = require("net");

const app = express();

// basic security - set this in env in real production
const API_KEY = process.env.PRINT_API_KEY || "1234";

// bind only to localhost for safety
const HOST = "127.0.0.1";
const PORT = process.env.PORT || 9900;

app.use(cors()); // you can lock down origin in prod
app.use(bodyParser.json({ limit: "10mb" }));

// --- Middleware to check API key ---
app.use((req, res, next) => {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
});

/**
 * GET /printers
 * Lists printers known to the OS (pdf-to-printer).
 */
app.get("/printers", async (req, res) => {
  try {
    const printers = await pdfPrinter.getPrinters();
    // printers is an array (Windows: name strings or objects depending on OS)
    res.json({ success: true, printers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /print
 * Body options:
 * {
 *   "mode": "os" | "tcp" | "ipp",   // default "os"
 *   "printerName": "HP LaserJet ...",  // for mode=os
 *   "printerIp": "192.168.1.150",      // for mode=tcp or mode=ipp
 *   "fileUrl": "https://...",           // URL of PDF to fetch & print (or)
 *   "fileBase64": "data:application/pdf;base64,..." // base64 PDF
 *   "raw": "string or buffer" // for tcp -> send raw commands
 * }
 */
app.post("/print", async (req, res) => {
  const {
    mode = "os",
    printerName,
    printerIp,
    fileUrl,
    fileBase64,
    raw,
  } = req.body;

  try {
    if (mode === "os") {
      // Must provide fileUrl or fileBase64
      if (!fileUrl && !fileBase64)
        return res.status(400).json({
          success: false,
          error: "fileUrl or fileBase64 required for mode=os",
        });

      let filePath;
      if (fileBase64) {
        // write temp file
        const match = fileBase64.match(/base64,(.*)$/);
        if (!match)
          return res
            .status(400)
            .json({ success: false, error: "Invalid fileBase64 payload" });
        const buffer = Buffer.from(match[1], "base64");
        filePath = path.join(__dirname, "tmp", `print-${Date.now()}.pdf`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buffer);
      } else {
        // download fileUrl to temp (simple fetch)
        const fetch = require("node-fetch");
        const resp = await fetch(fileUrl);
        if (!resp.ok)
          throw new Error(`Failed to fetch file: ${resp.statusText}`);
        const buffer = await resp.buffer();
        filePath = path.join(__dirname, "tmp", `print-${Date.now()}.pdf`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buffer);
      }

      // print via OS (uses installed printers & drivers)
      const options = {};
      if (printerName) options.printer = printerName;

      await pdfPrinter.print(filePath, options);

      // optionally cleanup
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        /* ignore */
      }

      return res.json({
        success: true,
        mode: "os",
        message: "Sent to OS print spooler",
      });
    }

    if (mode === "tcp") {
      // raw TCP to port 9100 - printer must support raw socket printing
      if (!printerIp)
        return res
          .status(400)
          .json({ success: false, error: "printerIp required for mode=tcp" });

      // raw payload - either raw string or base64 PDF (not typical)
      if (!raw)
        return res
          .status(400)
          .json({ success: false, error: "raw data required for tcp mode" });

      // send bytes to port 9100
      await new Promise((resolve, reject) => {
        const client = new net.Socket();
        client.connect(9100, printerIp, () => {
          // if raw is base64:
          const match = raw.match(/^data:.*;base64,(.*)$/);
          if (match) client.write(Buffer.from(match[1], "base64"));
          else client.write(raw);
          client.end();
        });

        client.on("close", () => resolve());
        client.on("error", (err) => reject(err));
      });

      return res.json({
        success: true,
        mode: "tcp",
        message: "Raw TCP sent to printer",
      });
    }

    if (mode === "ipp") {
      if (!printerIp)
        return res
          .status(400)
          .json({ success: false, error: "printerIp required for mode=ipp" });
      if (!fileUrl && !fileBase64)
        return res.status(400).json({
          success: false,
          error: "fileUrl or fileBase64 required for ipp",
        });

      // fetch or decode file
      let fileBuffer;
      if (fileBase64) {
        const match = fileBase64.match(/base64,(.*)$/);
        if (!match)
          return res
            .status(400)
            .json({ success: false, error: "Invalid fileBase64" });
        fileBuffer = Buffer.from(match[1], "base64");
      } else {
        const fetch = require("node-fetch");
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error("Failed to fetch fileUrl");
        fileBuffer = await response.buffer();
      }

      const printerURL = `http://${printerIp}:631/ipp/print`; // common IPP endpoint; may vary per printer
      const printer = ipp.Printer(printerURL);

      const msg = {
        "operation-attributes-tag": {
          "requesting-user-name": "nodejs",
          "job-name": "node-ipp-job",
          "document-format": "application/pdf",
        },
        data: fileBuffer,
      };

      await new Promise((resolve, reject) => {
        printer.execute("Print-Job", msg, (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });
      });

      return res.json({ success: true, mode: "ipp", message: "IPP job sent" });
    }

    return res.status(400).json({ success: false, error: "Unsupported mode" });
  } catch (err) {
    console.error("Print error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// simple health
app.get("/", (req, res) =>
  res.json({ success: true, message: "Print service running" })
);

app.listen(PORT, HOST, () => {
  console.log(
    `Print service listening at http://${HOST}:${PORT} (API key: set PRINT_API_KEY env var)`
  );
});
