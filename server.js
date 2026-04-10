const axios = require('axios');
const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/' });
const zlib = require('zlib');

app.use((req, res, next) => {
  if (req.path === '/upload-audio' && req.headers['content-encoding'] === 'gzip') {
    const gunzip = zlib.createGunzip();
    const chunks = [];
    req.pipe(gunzip);
    gunzip.on('data', chunk => chunks.push(chunk));
    gunzip.on('end', () => {
      req.body = Buffer.concat(chunks);
      next();
    });
    gunzip.on('error', next);
  } else {
    next();
  }
});
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FFmpeg server is running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/upload-audio', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  console.log('upload-audio body length:', req.body ? req.body.length : 'null/undefined');
  try {
    if (!req.body || req.body.length === 0) return res.status(400).json({ error: 'audio data が必要です' });
    const jobId = uuidv4();
    const audioDir = '/tmp/audio';
    fs.mkdirSync(audioDir, { recursive: true });
    const audioPath = path.join(audioDir, `${jobId}.wav`);
    fs.writeFileSync(audioPath, req.body);
    console.log('saved audio size:', fs.statSync(audioPath).size);
    res.json({ status: 'ok', job_id: jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/compose-from-comfyui', async (req, res) => {
  const jobId = uuidv4();
  const tmpDir = `/tmp/job_${jobId}`;

  const { prompt_id, comfyui_url, audio_job_id, audio, fps = 8, resolution = '854x480' } = req.body;
  if (!prompt_id || !comfyui_url) return res.status(400).json({ error: 'prompt_id と comfyui_url が必要です' });
  if (!audio_job_id && !audio) return res.status(400).json({ error: 'audio_job_id か audio が必要です' });

  res.json({ status: 'processing', job_id: jobId });

  (async () => {
    try {
      fs.mkdirSync(tmpDir, { recursive: true });

      let audioSrcPath;
      if (audio_job_id) {
        audioSrcPath = `/tmp/audio/${audio_job_id}.wav`;
        if (!fs.existsSync(audioSrcPath)) throw new Error('audio_job_id が無効か期限切れです');
      } else {
        audioSrcPath = `/tmp/audio/inline_${uuidv4()}.wav`;
        fs.mkdirSync('/tmp/audio', { recursive: true });
        const base64Data = audio.replace(/^data:audio\/\w+;base64,/, '');
        fs.writeFileSync(audioSrcPath, Buffer.from(base64Data, 'base64'));
        console.log('inline audio saved, size:', fs.statSync(audioSrcPath).size);
      }

      let historyRes;
      for (let attempt = 0; attempt < 30; attempt++) {
        historyRes = await axios.get(`${comfyui_url}/history/${prompt_id}`);
        if (historyRes.data[prompt_id]?.outputs) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      const outputs = historyRes.data[prompt_id]?.outputs;
      if (!outputs) throw new Error('画像生成タイムアウト');

      const images = [];
      for (const nodeId of Object.keys(outputs)) {
        for (const img of (outputs[nodeId].images || [])) {
          const imgRes = await axios.get(`${comfyui_url}/view?filename=${img.filename}&subfolder=${img.subfolder}&type=${img.type}`, { responseType: 'arraybuffer', decompress: false });
          const imgBase64 = Buffer.from(imgRes.data).toString('base64');
for (let i = 0; i < 20; i++) images.push(imgBase64);
          console.log('image downloaded, size:', imgRes.data.byteLength);
        }
      }

      for (let i = 0; i < images.length; i++) {
        const imgPath = path.join(tmpDir, `frame_${String(i).padStart(4, '0')}.png`);
        fs.writeFileSync(imgPath, Buffer.from(images[i], 'base64'));
      }

      const audioPath = path.join(tmpDir, 'audio.wav');
      fs.copyFileSync(audioSrcPath, audioPath);

      const outputPath = path.join(tmpDir, 'output.mp4');
      const [width, height] = resolution.split('x').map(Number);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(path.join(tmpDir, 'frame_%04d.png'))
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
      fs.unlinkSync(audioSrcPath);
      fs.writeFileSync(`/tmp/result_${jobId}.json`, JSON.stringify({ status: 'done', video: `data:video/mp4;base64,${videoBase64}` }));
      console.log('job done:', jobId);
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.writeFileSync(`/tmp/result_${jobId}.json`, JSON.stringify({ status: 'error', error: err.message }));
      console.log('job error:', jobId, err.message);
    }
  })();
});

app.get('/result/:jobId', (req, res) => {
  const resultPath = `/tmp/result_${req.params.jobId}.json`;
  if (!fs.existsSync(resultPath)) {
    return res.json({ status: 'processing' });
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  fs.unlinkSync(resultPath);
  res.json(result);
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
        .input(path.join(tmpDir, 'frame_%04d.png'))
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
app.get('/download-latest', (req, res) => {
  const files = require('fs').readdirSync('/tmp').filter(f => f.startsWith('result_') && f.endsWith('.json'));
  if (files.length === 0) return res.status(404).json({ error: 'no result found' });
  const latest = files.sort().reverse()[0];
  const result = JSON.parse(require('fs').readFileSync(`/tmp/${latest}`, 'utf8'));
  if (!result.video) return res.status(404).json({ error: 'no video in result' });
  const base64Data = result.video.replace(/^data:video\/mp4;base64,/, '');
  const buf = Buffer.from(base64Data, 'base64');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="output.mp4"');
  res.send(buf);
});
app.listen(PORT, () => console.log(`FFmpeg server running on port ${PORT}`));
