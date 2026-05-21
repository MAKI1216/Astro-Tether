import { AstroTetherGame } from './game.js'

const canvas = document.querySelector('#game')
const ui = {
  menu: document.querySelector('#menuOverlay'),
  menuStartTutorial: document.querySelector('#menuStartTutorial'),
  menuStartInfinite: document.querySelector('#menuStartInfinite'),
  tutorialModal: document.querySelector('#tutorialModal'),
  tutorialClose: document.querySelector('#tutorialClose'),
  tutorialSteps: document.querySelector('#tutorialSteps'),
  tutorialPrev: document.querySelector('#tutorialPrev'),
  tutorialNext: document.querySelector('#tutorialNext'),
  tutorialProgress: document.querySelector('#tutorialProgress'),
  gameHud: document.querySelector('#gameHud'),
  levelText: document.querySelector('#levelText'),
  energyFill: document.querySelector('#energyFill'),
  launchBtn: document.querySelector('#launchBtn'),
  clearBtn: document.querySelector('#clearBtn'),
  hintBtn: document.querySelector('#hintBtn'),
  homeBtn: document.querySelector('#homeBtn'),
  refreshBtn: document.querySelector('#refreshBtn'),
  statusOverlay: document.querySelector('#statusOverlay'),
  statusTitle: document.querySelector('#statusTitle'),
  statusBody: document.querySelector('#statusBody'),
  retryBtn: document.querySelector('#retryBtn'),
  nextBtn: document.querySelector('#nextBtn'),
  backHomeBtn: document.querySelector('#backHomeBtn'),
  lineTypeAdhesion: document.querySelector('#lineTypeAdhesion'),
  lineTypeBounce: document.querySelector('#lineTypeBounce'),
}

const tutorialPages = [
  {
    title: '欢迎来到星轨跃迁',
    body: '你的任务是用星尘绘制引力导轨，把探测器送进右侧虫洞。左上角是图例，帮助你识别起点、终点和发射方向。',
    accent: 'intro',
  },
  {
    title: '怎么操作',
    body: '按住鼠标拖动画线。按 1 切换吸附线，按 2 切换反弹线。能量条是全局共用的，画得越长消耗越多。',
    accent: 'controls',
  },
  {
    title: '线条含义',
    body: '吸附线会托住飞船顺着轨道前进，适合保底路线。反弹线会产生镜面反射，适合修正角度和绕开障碍。',
    accent: 'lines',
  },
  {
    title: '图标说明',
    body: '青色圆环是起点，紫色虫洞是终点，黄色箭头提示初始发射方向。灰色虚线表示星球的引力作用范围。',
    accent: 'icons',
  },
  {
    title: '开始前提醒',
    body: '浏览完后，点击右上角关闭教学窗口即可正式开始。教学期间不能画线，也不能发射探测器。',
    accent: 'ready',
  },
]

const game = new AstroTetherGame(canvas, ui)
game.setTutorialPages(tutorialPages)

const appState = {
  mode: 'menu',
  selectedMode: 'tutorial',
}

function showMenu() {
  appState.mode = 'menu'
  ui.menu.classList.add('is-visible')
  ui.gameHud.classList.add('is-hidden')
  ui.tutorialModal.classList.remove('is-visible')
  ui.statusOverlay.classList.remove('is-visible')
  game.setScene('menu')
}

function startTutorial() {
  appState.mode = 'tutorial'
  ui.menu.classList.remove('is-visible')
  ui.gameHud.classList.remove('is-hidden')
  game.setPaused(false)
  game.setInputLocked(false)
  game.startTutorialMode()
  openTutorial()
}

function startInfinite() {
  appState.mode = 'infinite'
  ui.menu.classList.remove('is-visible')
  ui.gameHud.classList.remove('is-hidden')
  game.setPaused(false)
  game.setInputLocked(false)
  game.startInfiniteMode(1)
  ui.tutorialModal.classList.remove('is-visible')
}

function openTutorial() {
  ui.tutorialModal.classList.add('is-visible')
  game.setPaused(true)
  game.setInputLocked(true)
  tutorialIndex = 0
  renderTutorialPage()
}

function closeTutorial() {
  ui.tutorialModal.classList.remove('is-visible')
  game.setPaused(false)
  game.setInputLocked(false)
  if (appState.mode === 'tutorial') {
    game.setScene('tutorial')
  }
}

function renderTutorialPage() {
  const page = tutorialPages[tutorialIndex]
  ui.tutorialSteps.innerHTML = `
    <div class="tutorial-pages">
      ${tutorialPages
        .map(
          (page, index) => `
            <article class="tutorial-card tutorial-page tutorial-page--${page.accent} ${index === tutorialIndex ? 'is-active' : ''}">
              <div class="tutorial-card__index">0${index + 1}</div>
              <h3>${page.title}</h3>
              <p>${page.body}</p>
              <div class="tutorial-card__grid">
                ${buildTutorialVisual(page.accent)}
              </div>
            </article>
          `,
        )
        .join('')}
    </div>
  `
  ui.tutorialProgress.textContent = `${tutorialIndex + 1} / ${tutorialPages.length}`
  ui.tutorialPrev.disabled = tutorialIndex === 0
  ui.tutorialNext.textContent = tutorialIndex === tutorialPages.length - 1 ? '完成' : '下一页'
  ui.tutorialClose.title = `当前：${page.title}`
  requestAnimationFrame(() => {
    const card = ui.tutorialSteps.querySelectorAll('.tutorial-page')[tutorialIndex]
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    }
  })
}

function buildTutorialVisual(accent) {
  if (accent === 'controls') {
    return `
      <div class="tutorial-visual tutorial-visual--controls">
        <div class="tutorial-visual__line tutorial-visual__line--adhesion"></div>
        <div class="tutorial-visual__line tutorial-visual__line--bounce"></div>
        <div class="tutorial-visual__key">1</div>
        <div class="tutorial-visual__key">2</div>
      </div>
    `
  }
  if (accent === 'lines') {
    return `
      <div class="tutorial-visual tutorial-visual--lines">
        <div class="tutorial-visual__tag tutorial-visual__tag--adhesion">吸附线：托住飞船</div>
        <div class="tutorial-visual__tag tutorial-visual__tag--bounce">反弹线：镜面反射</div>
      </div>
    `
  }
  if (accent === 'icons') {
    return `
      <div class="tutorial-visual tutorial-visual--icons">
        <div class="tutorial-visual__icon tutorial-visual__icon--start"></div>
        <div class="tutorial-visual__icon tutorial-visual__icon--goal"></div>
        <div class="tutorial-visual__icon tutorial-visual__icon--arrow"></div>
        <div class="tutorial-visual__icon tutorial-visual__icon--gravity"></div>
      </div>
    `
  }
  if (accent === 'ready') {
    return `
      <div class="tutorial-visual tutorial-visual--ready">
        <div class="tutorial-visual__panel">关闭后正式开始</div>
      </div>
    `
  }
  return `
    <div class="tutorial-visual tutorial-visual--intro">
      <div class="tutorial-visual__planet"></div>
      <div class="tutorial-visual__wormhole"></div>
      <div class="tutorial-visual__probe"></div>
    </div>
  `
}

let tutorialIndex = 0

ui.menuStartTutorial.addEventListener('click', startTutorial)
ui.menuStartInfinite.addEventListener('click', startInfinite)
ui.tutorialClose.addEventListener('click', () => {
  closeTutorial()
})
ui.tutorialPrev.addEventListener('click', () => {
  if (tutorialIndex === 0) return
  tutorialIndex -= 1
  renderTutorialPage()
})
ui.tutorialNext.addEventListener('click', () => {
  if (tutorialIndex < tutorialPages.length - 1) {
    tutorialIndex += 1
    renderTutorialPage()
    return
  }
  closeTutorial()
})

ui.homeBtn.addEventListener('click', () => {
  appState.selectedMode = game.sceneMode === 'tutorial' ? 'tutorial' : 'infinite'
  showMenu()
})

ui.refreshBtn.addEventListener('click', () => {
  game.refreshLevel()
})

ui.retryBtn.addEventListener('click', () => {
  game.restartCurrentLevel()
})
ui.nextBtn.addEventListener('click', () => {
  game.advanceLevel()
})

ui.lineTypeAdhesion.addEventListener('click', () => {
  game.setSelectedLineType('adhesion')
})

ui.lineTypeBounce.addEventListener('click', () => {
  game.setSelectedLineType('bounce')
})

game.onReturnHome = () => showMenu()
game.onEnterMenu = () => showMenu()
game.onEnterInfinite = () => {
  appState.selectedMode = 'infinite'
  startInfinite()
}

ui.backHomeBtn.addEventListener('click', () => showMenu())

ui.hintBtn.textContent = '[提示]'

showMenu()
game.start()
window.__astroTether = game
