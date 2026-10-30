# Scan & Play

A small football brain-training game built on real Bundesliga moments.

**Live demo:** https://scanandplay.vercel.app/

You're the player about to receive a pass. While the ball comes to you, look around and take in where your teammates and the opponents are. Then the screen goes dark, at the exact moment the real player passed, and you have two seconds to tap where you'd play it, from memory. The game then shows your pass, the pro's real pass and the best option it could find, and explains why.

Each round gives you three scores:

- **Decision**: how good your pass was compared with the best option.
- **Scan**: whether you looked around late enough, and whether you spotted the best option.
- **Memory**: how accurately you remembered where your teammate was.

## Slides

[Scan_and_Play_Brain1.pptx](Scan_and_Play_Brain1.pptx) is a short 8-slide deck about the idea: why scanning and quick decisions matter in football, how the game trains them, and how it differs from a typical brain game.

## Running it

You'll need a recent version of Node.js.

```bash
npm install
npm run dev      # start a local dev server
npm run build    # build the static site into dist/
```

There's no backend. Progress is saved in the browser, so the `dist/` folder can be hosted anywhere static (Netlify and Vercel configs are included).

## Adding moments

The moments are plain JSON files in `public/moments/`. They're made from the raw DFL data with a Python script, which needs `kloppy`, `numpy` and `matplotlib`:

```bash
python extract_moments.py --n 30 --out new_moments
# copy the files into public/moments/, then:
npm run manifest
npm run check
```

`npm run check` runs every moment through the game's own model and catches anything that doesn't add up.

## Credits

- Tracking and event data: Deutsche Fußball Liga (DFL), published as open data by Bassek et al. (2025), *Scientific Data*, CC BY 4.0.
- Expected Possession Value grid: Laurie Shaw, [LaurieOnTracking](https://github.com/Friends-of-Tracking-Data-FoTD/LaurieOnTracking), MIT licence.
- 3D player model: "Man" by Quaternius, CC0.
