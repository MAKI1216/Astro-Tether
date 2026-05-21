import fs from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
const root = process.cwd()
const distDir = path.join(root, 'dist-file')
const outFile = path.join(distDir, 'app.js')
const htmlOut = path.join(root, 'index.html')
const cssPath = path.join(root, 'src', 'style.css')

await fs.mkdir(distDir, { recursive: true })

await build({
  entryPoints: [path.join(root, 'src', 'main.js')],
  bundle: true,
  format: 'iife',
  globalName: 'AstroTetherBundle',
  outfile: outFile,
  define: {
    'window.Matter': 'window.Matter',
  },
  loader: {
    '.css': 'css',
  },
  external: [],
  target: ['es2020'],
})

const css = await fs.readFile(cssPath, 'utf-8')
const js = await fs.readFile(outFile, 'utf-8')

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Astro-Tether</title>
    <meta name="description" content="Astro-Tether - 2D 引力划线解谜游戏" />
    <style>${css}</style>
  </head>
  <body>
    <div id="app">
      <canvas id="game" aria-label="Astro-Tether game canvas"></canvas>

      <section id="menuOverlay" class="menu is-visible">
        <div class="menu__card">
          <div class="menu__glow"></div>
          <p class="menu__subtitle">星轨跃迁 / Astro-Tether</p>
          <h1 class="menu__title">Astro-Tether</h1>
          <div class="menu__subtitle">星轨跃迁</div>
          <div class="menu__actions">
            <button id="menuStartTutorial" class="menu__button">进入教学关卡</button>
            <button id="menuStartInfinite" class="menu__button">进入无尽关卡</button>
          </div>
          <div class="menu__panel">
            <div class="menu__feature">
              <h3>教学关卡</h3>
              <p>固定简单关卡。会先弹出可滑动教学窗口，学会图例、线型和操作后再开始。</p>
            </div>
            <div class="menu__feature">
              <h3>无尽关卡</h3>
              <p>每次进入都会重新生成随机地图，可通过刷新关卡来更换新的宇宙布景。</p>
            </div>
          </div>
          <div class="menu__resume">菜单页只是入口，不会消耗星尘能量。</div>
        </div>
      </section>

      <div id="tutorialModal" class="tutorial-modal" aria-hidden="true">
        <div class="tutorial-modal__card">
          <div class="tutorial-modal__header">
            <h2 class="tutorial-modal__title">教学指引</h2>
            <button id="tutorialClose" class="tutorial-modal__close" aria-label="关闭教学窗口">×</button>
          </div>
          <div id="tutorialSteps" class="tutorial-modal__body"></div>
          <div class="tutorial-modal__footer">
            <div id="tutorialProgress" class="menu__resume">1 / 5</div>
            <div class="overlay__actions">
              <button id="tutorialPrev" class="overlay__button">上一页</button>
              <button id="tutorialNext" class="overlay__button">下一页</button>
            </div>
          </div>
        </div>
      </div>

      <div id="gameHud" class="hud is-hidden">
        <div class="legend" aria-label="图例">
          <div class="legend__item"><span class="legend__mark legend__mark--start"></span>起点舱</div>
          <div class="legend__item"><span class="legend__mark legend__mark--goal"></span>终点虫洞</div>
          <div class="legend__item"><span class="legend__mark legend__mark--arrow"></span>发射方向</div>
        </div>
        <div class="line-types" aria-label="线条种类">
          <div id="lineTypeAdhesion" class="line-types__item is-active">
            <span class="line-types__sample line-types__sample--adhesion"></span>1 吸附线
          </div>
          <div id="lineTypeBounce" class="line-types__item">
            <span class="line-types__sample line-types__sample--bounce"></span>2 反弹线
          </div>
        </div>
        <div class="hud__panel-row">
          <div class="hud__panel">
            <span class="hud__label">关卡</span>
            <span id="levelText" class="hud__value">1</span>
          </div>
          <div class="hud__panel hud__panel--wide">
            <span class="hud__label">星尘能量</span>
            <div class="energy">
              <div id="energyFill" class="energy__fill"></div>
            </div>
          </div>
        </div>
        <div class="hud__row hud__row--buttons">
          <button id="launchBtn" class="hud__button">[发射]</button>
          <button id="clearBtn" class="hud__button">[清除]</button>
          <button id="hintBtn" class="hud__button">[教学]</button>
          <button id="homeBtn" class="hud__button">[主页]</button>
          <button id="refreshBtn" class="hud__button">[刷新]</button>
        </div>
      </div>

      <div id="statusOverlay" class="overlay" aria-live="polite">
        <div id="statusTitle" class="overlay__title"></div>
        <div id="statusBody" class="overlay__body"></div>
        <div class="overlay__actions">
          <button id="retryBtn" class="overlay__button">[重试]</button>
          <button id="nextBtn" class="overlay__button">[下一关]</button>
          <button id="backHomeBtn" class="overlay__button">[返回主页]</button>
        </div>
      </div>
    </div>
    <script src="./vendor/matter.min.js"></script>
    <script src="./game.config.js"></script>
    <script>${js}</script>
  </body>
</html>`

await fs.writeFile(htmlOut, html, 'utf-8')
console.log('Built self-contained index.html')
