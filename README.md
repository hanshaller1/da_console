# Chroma Console Web

Ein Browser-Nachbau des **Hologram Electronics Chroma Console** – komplett in Web Audio, ohne Build-Schritt und ohne Abhängigkeiten.
Fanprojekt, nicht mit Hologram Electronics verbunden. Alle Effekte sind eigene DSP-Interpretationen nach den Beschreibungen im Handbuch.

## Starten

AudioWorklets brauchen `http(s)://` (nicht `file://`):

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

Oder per GitHub Pages: *Settings → Pages → Deploy from a branch → `main` / root*.

## Was nachgebaut ist

| Pedal | Web-App |
|---|---|
| 4 Module in Serie: **Character → Movement → Diffusion → Texture** | ✓, Reihenfolge per **FX Setup (A+D)** frei wählbar |
| 20 Effekte (5 pro Modul) | ✓ alle 20, siehe unten |
| 8 Knöpfe mit Zweitfunktion (graue Beschriftung) | ✓ TILT/SENSITIVITY, RATE/DRIFT, TIME/DRIFT, MIX/OUTPUT, 4× AMOUNT/EFFECT VOL – umschalten mit **Shift (A+B)** |
| Modul-Taster: drücken = Effekt wechseln, halten = Modul-Bypass | ✓ (Maus/Touch oder Tasten `1`–`4`) |
| Tasterkombinationen | ✓ zwei Taster gleichzeitig halten (z. B. `1`+`2`) oder Buttons unter dem Pedal |
| **Gesture** (C+D): Knopfbewegungen aufnehmen und loopen, Overdub | ✓, auch in Presets gespeichert |
| **Capture**: TAP halten = aufnehmen (bis 30 s), loslassen = Loop; kurze Loops werden zu nahtlosen Pads | ✓, Pre-/Post-FX-Routing |
| Tap-Tempo | ✓ synchronisiert Movement-RATE und Delay-TIME |
| 80 Presets in Bank A/B | ✓ im Browser (localStorage), Export/Import als JSON, 10 Werkspresets |
| Kalibrierung (4 Eingangsstufen, Auto) | ✓ |
| Bypass-Fußschalter, halten = Presets | ✓ (`B`) |

Extras: eingebaute Demo-Loops (Karplus-Strong-Gitarre, synthetische Drums), Mikrofon/Line-In, eigene Audiodateien, Aufnahme des Ausgangs als Download, Spektrum/Oszilloskop und eine Pedal-Grafik, die auf die gewählten Effekte und den Pegel reagiert.

### Effekte

- **Character** – Drive (Röhren-Overdrive), Sweeten (Preamp mit EQ/Kompression), Fuzz (asymmetrisch, „blown speaker“), Howl (resonanter Hüllkurven-Filter-Fuzz), Swell (automatische Volume-Swells)
- **Movement** – Doubler (Stereo-Double-Tracking), Vibrato, Phaser (6 Stufen), Tremolo (Drift = Autopan), Pitch (±12 Halbtöne, granularer Shifter; RATE = Mix)
- **Diffusion** – Cascade (BBD-Delay mit Taktglide), Reels (Bandecho, Wow/Flutter, zweiter Kopf), Space (8-Kanal-FDN-Hall mit Freeze), Collage (granulares Looping-Delay), Reverse (Rückwärts-Delay)
- **Texture** – Filter (DJ-Filter LP/HP), Squash (Kompression + Overdrive), Cassette (Leiern, Rauschen, Aussetzer), Broken (Pitch-Einbrüche mit AM), Interference (Bitcrush, Funkstörungen, Zerfall)

## Aufbau

```
index.html                 Oberfläche
css/style.css
js/main.js                 UI-Logik, Taster/Kombos, Fußschalter, Tap, Presets, Visuals
js/engine.js               AudioContext, Quellen (Demo/Mikro/Datei), Aufnahme
js/meta.js                 Module, Effekte, Knopfbelegung, Werte-Anzeige
js/knob.js                 Drehregler-Komponente
js/gesture.js              Gesture-Automation
js/presets.js              80 Slots + Werkspresets
worklet/chroma-processor.js  komplette DSP (alle Effekte, Routing, Capture) als AudioWorklet
test/dsp-test.mjs          Offline-Stabilitätstest aller Effekte
```

## Test

```bash
node test/dsp-test.mjs
```

Rendert jeden Effekt mit Standard- und Maximal-Einstellungen sowie zufällige Gesamtketten und prüft auf NaN, Übersteuerung und Echtzeitfähigkeit.

## Einzeldatei-Build

```bash
node tools/build-single.mjs dist/chroma-console.html            # eigenständige HTML-Datei
node tools/build-single.mjs dist/chroma-console.html --artifact  # Variante für claude.ai-Artifacts (ohne Mikrofon)
```

Bündelt alles inklusive Worklet in eine Datei. Auch die muss über http(s) geöffnet werden, weil Browser Worklets von `file://` blockieren.
