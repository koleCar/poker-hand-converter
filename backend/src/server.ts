import archiver from "archiver";
import cors from "cors";
import express from "express";
import multer from "multer";
import type { ArchiverError } from "archiver";
import { convertUploadedFiles, getJob } from "./services/conversionService.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 200, fileSize: 10 * 1024 * 1024 },
});

export function createServer() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/convert", upload.array("files"), (req, res) => {
    const files = (req.files ?? []) as Array<{ originalname: string; buffer: Buffer }>;
    if (!files.length) {
      res.status(400).json({ error: "No files uploaded. Use multipart field 'files'." });
      return;
    }

    const job = convertUploadedFiles(files);
    res.json(job.report);
  });

  app.get("/api/download/:jobId", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Conversion job not found." });
      return;
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="converted-${job.report.id}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err: ArchiverError) => {
      res.status(500).end(err.message);
    });

    archive.pipe(res);

    for (const file of job.convertedFiles) {
      archive.append(file.outputText, { name: file.outputFileName });
    }

    archive.append(JSON.stringify(job.report, null, 2), { name: "report.json" });
    void archive.finalize();
  });

  return app;
}
