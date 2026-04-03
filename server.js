const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/' });
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FFmpeg server is running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/compose', async (req, res) => {
  const jobId = uuidv4();
  const tmpDir = `/tmp/job_${jobId}`;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const { images, audio, fps = 8, resolution = '854x480' } = req.body;
    if (!images || images.length === 0) return res.status(400).json({ error: 'images が必要です' });
    if (!audio) return res.status(400).json({ error: 'audio が必要です' });
    for (let i = 0; i < images.length; i++) {
      const imgPath = path.join(tmpDir, `frame_${String(i).padStart(4, '0')}.jpg`);
      const base64Data = images[i].replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));
    }
    const audioPath = path.join(tmpDir, 'audio.wav');
    fs.writeFileSync(audioPath, Buffer.from(audio.replace(/^data:audio\/\w+;base64,/, ''), 'base64'));
    const outputPath = path.join(tmpDir, 'output.mp4');
    const [width, height] = resolution.split('x').map(Number);
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.join(tmpDir, 'frame_%04d.jpg'))
        .inputOptions([`-framerate ${fps}`])
        .input(audioPath)
        .outputOptions([
          '-c:v libx264', '-crf 23', '-preset fast',
          '-c:a aac', '-b:a 128k',
          `-vf scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
          '-shortest', '-movflags +faststart', '-pix_fmt yuv420p',
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    const videoBase64 = fs.readFileSync(outputPath).toString('base64');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.json({ status: 'ok', video: `data:video/mp4;base64,${videoBase64}` });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.post('/thumbnail', async (req, res) => {
  const jobId = uuidv4();
  const tmpDir = `/tmp/thumb_${jobId}`;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'image が必要です' });
    const inputPath = path.join(tmpDir, 'input.jpg');
    const outputPath = path.join(tmpDir, 'thumbnail.jpg');
    fs.writeFileSync(inputPath, Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(['-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    const thumbBase64 = fs.readFileSync(outputPath).toString('base64');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.json({ status: 'ok', thumbnail: `data:image/jpeg;base64,${thumbBase64}` });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`FFmpeg server running on port ${PORT}`));
