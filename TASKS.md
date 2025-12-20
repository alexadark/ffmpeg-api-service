# FFmpeg API Service - Roadmap Auto-Edit

## Objectif Global
Transformer cette API en un "auto-editor" production-ready comme Recut/Descript, capable de nettoyer automatiquement les vidéos.

---

## Phase 1 : Audio Enhancement & Silence Detection (CRITIQUE)

### Task 1.1: POST /api/enhance-audio
**Objectif** : Améliorer la qualité audio (noise reduction + voix claire)

**Endpoint** :
```
POST /api/enhance-audio
Body: {
  "url": "https://...",
  "noiseFloor": -20,        // dB (default: -20)
  "voiceBoost": true,       // highpass + loudnorm
  "output": { "format": "mp4" }
}

Response: {
  "videoUrl": "https://.../enhanced-audio-xxx.mp4",
  "audioStats": {
    "originalLUFS": -22.5,
    "finalLUFS": -14,
    "noiseReduction": "20dB"
  }
}
```

**Filtres FFMPEG à utiliser** :
- `highpass=f=80` - Enlève grondements
- `lowpass=f=12000` - Enlève sifflements
- `afftdn=nf=-20` - Noise reduction
- `compand` - Compression dynamique
- `loudnorm=I=-14:TP=-1:LRA=11` - Normalisation broadcast

**Fichiers à modifier** :
- `lib/ffmpeg.js` : ajouter fonction `enhanceAudio()`
- `server.js` : ajouter route POST /api/enhance-audio

---

### Task 1.2: POST /api/detect-silence
**Objectif** : Retourner la liste des silences (timecodes)

**Endpoint** :
```
POST /api/detect-silence
Body: {
  "url": "https://...",
  "threshold": "-35dB",     // Sensitivity (default: -35dB)
  "minDuration": 0.5        // Silence minimum en secondes
}

Response: {
  "silences": [
    { "start": 2.345, "end": 3.123, "duration": 0.778 },
    { "start": 15.678, "end": 18.234, "duration": 2.556 },
    ...
  ],
  "totalSilenceDuration": 45.3,
  "videoUrl": "https://...",
  "originalDuration": 120
}
```

**Commande FFMPEG** :
```bash
ffmpeg -i input.mp4 -af "silencedetect=n=-35dB:d=0.5" -f null -
```

**Fichiers à modifier** :
- `lib/ffmpeg.js` : ajouter fonction `detectSilence()`
- `server.js` : ajouter route POST /api/detect-silence

---

### Task 1.3: POST /api/trim
**Objectif** : Découper un segment d'une vidéo (ultra-rapide, copy codec)

**Endpoint** :
```
POST /api/trim
Body: {
  "url": "https://...",
  "start": 0,               // secondes
  "end": 30.5,              // secondes
  "output": { "resolution": "1920x1080", "format": "mp4" }
}

Response: {
  "videoUrl": "https://.../trimmed-xxx.mp4",
  "duration": 30.5,
  "processingTime": 500
}
```

**Stratégies FFMPEG** :
- **Fast mode (copy)** : `-ss {start} -to {end} -i input -c copy` (500ms)
- **High quality** : `-ss {start} -to {end} -i input -c:v libx264` (10s pour 30s)

→ Utiliser COPY par défaut pour l'API (plus rapide)

**Fichiers à modifier** :
- `lib/ffmpeg.js` : ajouter fonction `trimVideo()`
- `server.js` : ajouter route POST /api/trim

---

## Phase 2 : Audio Analysis & Auto-Edit ✅ COMPLETED

### Task 2.1: POST /api/extract-audio ✅
**Objectif** : Extraire l'audio au format MP3 pour envoyer à Whisper/transcription

**Endpoint** :
```
POST /api/extract-audio
Body: {
  "url": "https://...",
  "format": "mp3",          // ou "wav", "aac" (default: mp3)
  "bitrate": "192k"         // (default: 192k)
}

Response: {
  "audioUrl": "https://.../audio-xxx.mp3",
  "duration": 120.5,
  "fileSize": 2887680
}
```

**Commande FFMPEG** :
```bash
ffmpeg -i input.mp4 -vn -acodec libmp3lame -ab 192k output.mp3
```

**Fichiers à modifier** :
- `lib/ffmpeg.js` : ajouter fonction `extractAudio()`
- `server.js` : ajouter route POST /api/extract-audio

---

### Task 2.2: POST /api/auto-edit (Hybrid: FFmpeg + Whisper + IA) ✅
**Objectif** : Pipeline complet auto-edit (silences + filler words + assemblage)

**Architecture** :
1. Extraire audio
2. Transcrire avec Whisper (depuis n8n)
3. Analyser avec IA (GPT/Gemini) → détecter filler words + silences
4. Fusionner les segments à couper
5. Découper et assembler avec /api/trim

**Endpoint** :
```
POST /api/auto-edit
Body: {
  "url": "https://...",
  "silenceThreshold": "-35dB",
  "minSilenceDuration": 0.5,
  "fillerWords": [          // Optionnel: custom list
    "euh", "ah", "donc", "du coup", "en fait", "tu sais"
  ],
  "strategy": "aggressive",  // "light" | "normal" | "aggressive"
  "output": { "resolution": "1920x1080" }
}

Response: {
  "videoUrl": "https://.../auto-edited-xxx.mp4",
  "originalDuration": 120.5,
  "editedDuration": 95.3,
  "timeRemoved": 25.2,
  "stats": {
    "silencesCut": 12,
    "fillerWordsCut": 8,
    "totalCuts": 20,
    "averageSegmentLength": 4.8
  },
  "processingTime": 15000
}
```

**Note** : Cette fonction nécessite :
- Extraction audio
- Appel externe à Whisper (via n8n ou API)
- Appel externe à IA (GPT-4/Gemini)
- Orchestration dans n8n est plus appropriée

**Stratégie recommandée** :
→ Créer cette fonction comme "orchestration n8n" plutôt que endpoint API directement
→ Ou faire un endpoint `/api/auto-edit` qui retourne un jobId et accepte callback URL

**Fichiers à modifier** :
- `lib/ffmpeg.js` : ajouter fonction `autoEdit()` avec jobId async
- `server.js` : ajouter route POST /api/auto-edit

---

### Task 2.3: Filler Words List (Default Database) ✅
**Fichier** : `lib/filler-words.js`

```javascript
module.exports = {
  fr: [
    'euh', 'ah', 'donc', 'du coup', 'en fait', 'tu sais',
    'genre', 'quoi', 'ouais', 'ben', 'alors', 'voilà'
  ],
  en: [
    'uh', 'um', 'ah', 'like', 'you know', 'actually',
    'basically', 'essentially', 'literally', 'honestly'
  ],
  es: [
    'eh', 'uh', 'este', 'pues', 'entonces', 'la verdad'
  ]
};
```

---

## Phase 3 : Short-Form & Subtitles ✅ COMPLETED

### Task 3.1: POST /api/crop ✅
**Objectif** : Recadrage pour format vertical (9:16) et autres ratios

**Endpoint** :
```
POST /api/crop
Body: {
  "url": "https://...",
  "aspectRatio": "9:16",    // "9:16" | "1:1" | "16:9" | "4:3"
  "position": "center",     // "center" | "top" | "bottom" | "left" | "right"
  "zoom": 1.0,              // Zoom avant (1.0 = normal)
  "output": { "format": "mp4" }
}

Response: {
  "videoUrl": "https://.../cropped-xxx.mp4",
  "originalResolution": "1920x1080",
  "croppedResolution": "608x1080",
  "position": "center"
}
```

**Logique** :
- 9:16 (portrait) : width = height * 9/16
- 1:1 (square) : width = height
- Position détermine le crop (center = crop des côtés, top = crop du bas, etc.)

**Commande FFMPEG** (exemple 9:16 centered) :
```bash
ffmpeg -i input.mp4 -vf "crop=ih*9/16:ih:(iw-ih*9/16)/2:0" output.mp4
```

**Fichiers à modifier** :
- `lib/ffmpeg.js` : ajouter fonction `cropVideo()`
- `server.js` : ajouter route POST /api/crop

---

### Task 3.2: POST /api/add-subtitles ✅
**Objectif** : Incruster des sous-titres SRT stylisés

**Endpoint** :
```
POST /api/add-subtitles
Body: {
  "url": "https://...",
  "subtitles": "1\n00:00:01,000 --> 00:00:03,000\nBonjour tout le monde\n\n2\n00:00:03,500 --> 00:00:06,000\nCeci est un test",
  "style": "bold-white",    // "bold-white" | "bold-yellow" | "minimal" | "custom"
  "fontSize": 24,           // (default: 24)
  "position": "bottom",     // "bottom" | "top" | "center"
  "backgroundColor": "transparent", // ou couleur hex
  "output": { "format": "mp4" }
}

Response: {
  "videoUrl": "https://.../subtitled-xxx.mp4",
  "subtitleCount": 2
}
```

**Styles prédéfinis ASS** :
```
bold-white : Gras blanc, contour noir
bold-yellow : Gras jaune, contour noir (YouTube style)
minimal : Sans contour, blanc transparent
custom : User-defined colors
```

**Commande FFMPEG** (avec fichier ASS stylisé) :
```bash
ffmpeg -i input.mp4 -vf "subtitles=subs.ass" output.mp4
```

**Processus** :
1. Parser SRT reçu
2. Générer fichier ASS avec styling
3. Passer à FFMPEG

**Fichiers à modifier** :
- `lib/ffmpeg.js` : ajouter fonction `addSubtitles()` + helper `generateASSFile()`
- `lib/subtitle-parser.js` : nouveau fichier, parser SRT → ASS
- `server.js` : ajouter route POST /api/add-subtitles

---

### Task 3.3: POST /api/add-subtitles-auto (Bonus)
**Objectif** : Auto-générer sous-titres à partir de Whisper (n8n)

Utiliser `/api/extract-audio` + Whisper dans n8n → générer SRT → `/api/add-subtitles`

---

## Phase 4 : Color Grading & Advanced Effects

### Task 4.1: POST /api/color-grade
**Objectif** : Appliquer color grading/LUT ou ajustements de couleur

**Endpoint** :
```
POST /api/color-grade
Body: {
  "url": "https://...",
  "preset": "cinematic",     // "cinematic" | "vintage" | "cool" | "warm" | "vibrant" | "custom"
  "intensity": 1.0,          // 0.0-1.0 (strength du grade)
  "lut": "https://...",      // Custom LUT file (optional)
  "adjustments": {           // Fine-tuning (optional)
    "saturation": 1.2,       // 0.5-2.0
    "contrast": 1.1,         // 0.5-2.0
    "brightness": 0.0,       // -1.0 to +1.0
    "gamma": 1.0,            // 0.5-2.0
    "highlights": 1.0,       // 0.5-2.0
    "shadows": 1.0,          // 0.5-2.0
    "temperature": 0         // -50 to +50 (warmth)
  },
  "output": { "resolution": "1920x1080" }
}

Response: {
  "videoUrl": "https://.../color-graded-xxx.mp4",
  "preset": "cinematic",
  "intensity": 1.0
}
```

**Presets disponibles** :

| Preset | Effect | FFMPEG Filter |
|--------|--------|---------------|
| `cinematic` | Contraste riche, teintes chaudes (look film) | colorspace, contrast, saturation |
| `vintage` | Faded, couleurs muted, vignette | colorspace, saturation-30%, vignette |
| `cool` | Blues froids, desaturated | colorspace, colortemperature=-30 |
| `warm` | Oranges/dorés chauds | colorspace, colortemperature=+30 |
| `vibrant` | Saturation max, contraste high | colorspace, saturation+40% |

**Commandes FFMPEG** (exemples) :

```bash
# Cinematic Look
ffmpeg -i input.mp4 -vf "
  colorspace=iall=bt709,
  eq=contrast=1.3:saturation=1.2,
  colortemperature=1000
" output.mp4

# Vintage Look
ffmpeg -i input.mp4 -vf "
  colorspace=iall=bt709,
  eq=saturation=0.7,
  vignette=angle=PI/4:mode=polynomial
" output.mp4

# Custom with LUT (advanced)
ffmpeg -i input.mp4 -vf "lut3d=file.cube" output.mp4
```

**Fichiers à modifier** :
- `lib/ffmpeg.js` : ajouter fonction `applyColorGrade()`
- `lib/lut-presets.js` : nouveau fichier avec presets
- `server.js` : ajouter route POST /api/color-grade

---

### Task 4.2: POST /api/stabilize (Bonus - Advanced)
**Objectif** : Stabiliser vidéos tremblantes (vidéo sur trépied, etc.)

**Endpoint** :
```
POST /api/stabilize
Body: {
  "url": "https://...",
  "strength": "medium",      // "light" | "medium" | "strong"
  "output": { "resolution": "1920x1080" }
}

Response: {
  "videoUrl": "https://.../stabilized-xxx.mp4",
  "strength": "medium"
}
```

**Commande FFMPEG** (utilise vidstab) :
```bash
# First pass: analyze motion
ffmpeg -i input.mp4 -vf vidstabdetect=shakiness=5:result=vidstab.trf -f null -

# Second pass: apply stabilization
ffmpeg -i input.mp4 -vf vidstabtransform=input=vidstab.trf:smoothing=30 output.mp4
```

**Note** : Nécessite lib vidstab, plus complexe

---

## Transitions & Extras (FUTURE)

### Autres transitions (optionnel)
- `fadeblack` - Fondu via noir
- `fadewhite` - Fondu via blanc
- `wipeleft` - Balayage gauche

**Recommandation** : Stick avec `fade` pour maintenant. Ajouter plus tard si demande utilisateur.

### Autres idées FFMPEG (future)
- Speed up/slow motion (1.2x, 0.5x)
- Watermark insertion
- Thumbnail extraction
- GIF creation

---

## Testing Strategy

### Unit Tests (lib/ffmpeg.js)
```javascript
// Test enhance-audio avec vidéo de test
// Test detect-silence retourne format correct
// Test trim avec différents cas (0-30s, milieu, fin)
```

### Integration Tests (server.js)
```bash
curl -X POST http://localhost:3000/api/enhance-audio \
  -H "X-API-Key: test-key" \
  -d '{"url": "https://test-video.com/sample.mp4"}'
```

---

## Performance Targets

| Operation | Target Time | Notes |
|-----------|------------|-------|
| enhance-audio (5min video) | 8-12s | Real-time audio processing |
| detect-silence (5min video) | 2-3s | FFmpeg analysis only |
| trim (30s segment) | <1s | Copy codec, no re-encode |
| assemble (10 clips) | 15-20s | Depends on total duration |

---

## Priority Order

1. ✅ **Task 1.1** - enhance-audio (foundational)
2. ✅ **Task 1.2** - detect-silence (enables Phase 2)
3. ✅ **Task 1.3** - trim (building block)
4. ✅ **Task 2.1** - extract-audio (MP3/WAV/AAC extraction for Whisper)
5. ✅ **Task 2.2** - auto-edit (silence removal + segment assembly)
6. ✅ **Task 2.3** - filler words database (multi-language support)
7. ✅ Task 3.1 - crop (aspect ratio conversion)
8. ✅ Task 3.2 - add-subtitles (SRT/ASS styling)

---

## Notes Techniques

### Audio Codec Considerations
- Input: Various (AAC, MP3, Opus, etc.)
- Processing: Always normalize to -14 LUFS (broadcast standard)
- Output: AAC 192kbps (good quality/size balance)

### Error Handling
- Validate video URL is accessible
- Check FFmpeg availability on startup
- Handle network timeouts (download failures)
- Return meaningful error messages

### Async Processing
All three endpoints should support:
- Sync mode (immediate response)
- Async mode with `callbackUrl` (like /api/assemble does)

---

## Files to Create/Modify

```
lib/
  ├── ffmpeg.js          (add 3 functions)
  └── storage.js         (reuse existing)

server.js                (add 3 routes)
tests/
  ├── enhance-audio.test.js
  ├── detect-silence.test.js
  └── trim.test.js
```

---

## Success Criteria

- [ ] All 3 Phase 1 endpoints deployed
- [ ] Each endpoint returns correct response format
- [ ] Performance targets met
- [ ] Error handling covers edge cases
- [ ] Works with real YouTube videos (async)
- [ ] n8n integration tested

---

Generated: 2025-12-20
Updated: As implementation progresses
