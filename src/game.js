import {
  clamp,
  cubicBezierPoint,
  cubicBezierTangent,
  createRng,
  createRockSilhouette,
  distance,
  easeOutCubic,
  lerp,
  normalize,
  polylineLength,
} from './utils.js'

const Matter = window.Matter

const {
  Bodies,
  Body,
  Composite,
  Engine,
  Events,
} = Matter

const PROBE_RADIUS = 7
const MAX_TRAIL_POINTS = 30
const DRAW_THRESHOLD = 15
const WALL_THICKNESS = 12
const BOUNCE_ANGLE_THRESHOLD = Math.cos(Math.PI * 0.38)
const WALL_CONTACT_PUSH = 0.8
const WALL_SLIDE_DAMPING = 0.999
const WALL_NEAR_DISTANCE = 18
const WALL_ADHESION_RELEASE_DISTANCE = 24
const PROBE_AIR_DRAG = 0
const GRAVITY_FORCE_SCALE = 860000
const DEFAULT_GAME_CONFIG = {
  planetGravityForceMultiplier: 4.5,
}
const LINE_TYPES = {
  adhesion: {
    key: 'adhesion',
    label: '吸附线',
    color: 'rgba(125, 255, 141, 0.92)',
    glow: 'rgba(125, 255, 141, 0.72)',
    cost: 1.35,
    mode: 'adhesion',
  },
  bounce: {
    key: 'bounce',
    label: '反弹线',
    color: 'rgba(255, 228, 107, 0.95)',
    glow: 'rgba(255, 228, 107, 0.72)',
    cost: 0.85,
    mode: 'bounce',
  },
  future: {
    key: 'future',
    label: '预留',
    color: 'rgba(177, 108, 255, 0.95)',
    glow: 'rgba(177, 108, 255, 0.72)',
    cost: 1,
    mode: 'future',
  },
}

function getGameConfig() {
  return { ...DEFAULT_GAME_CONFIG, ...(window.__ASTRO_TETHER_CONFIG__ || {}) }
}

export class AstroTetherGame {
  constructor(canvas, ui) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.ui = ui

    this.engine = Engine.create()
    this.world = this.engine.world
    this.world.gravity.x = 0
    this.world.gravity.y = 0

    this.width = 1
    this.height = 1
    this.dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))

    this.level = 1
    this.levelData = null
    this.energy = 0
    this.energyMax = 1
    this.selectedLineType = 'adhesion'
    this.state = 'idle'
    this.sceneMode = 'menu'
    this.inputLocked = true
    this.paused = false
    this.hintUntil = 0
    this.winAt = 0
    this.failReason = ''
    this.pendingNextLevelAt = 0
    this.lastFrameTime = 0
    this.nextStrokeId = 1
    this.railCooldown = null
    this.lastResult = null
    this.gravityMitigation = null

    this.pointer = {
      drawing: false,
      last: null,
      active: null,
      strokeId: null,
      strokeIndex: 0,
    }
    this.wallContacts = new Map()
    this.strokes = new Map()
    this.activeRail = null

    this.backgroundTheme = this.createCosmicBackdrop(24, 'menu')
    this.stars = this.backgroundTheme.stars
    this.particles = []
    this.drawnSegments = []
    this.drawnBodies = []
    this.drawnStrokes = []
    this.planets = []
    this.speedRings = []
    this.asteroids = []
    this.goldPath = []
    this.pathGuideSegments = []
    this.probeTrail = []
    this.planetGravityPulse = new Map()
    this.lineTypeEls = {
      adhesion: null,
      bounce: null,
    }
    this.tutorialPages = []
    this.tutorialLocked = false
    this.autoRefreshEnabled = false
    this.currentLevelSeed = 1
    this.hintVisible = false
    this.onReturnHome = null
    this.onEnterMenu = null
    this.onEnterTutorial = null
    this.onEnterInfinite = null
    this.gameConfig = getGameConfig()

    this.bindEvents()

    Events.on(this.engine, 'beforeUpdate', () => {
      this.applyPlanetGravity()
      this.applyGravityMitigation()
    })

    Events.on(this.engine, 'collisionStart', (event) => {
      this.handleCollisionStart(event)
    })
  }

  start() {
    this.resize()
    this.goToLevel(1)
    requestAnimationFrame(() => {
      this.syncLayout()
    })

    const loop = (time) => {
      const dt = this.lastFrameTime ? Math.min(time - this.lastFrameTime, 33.333) : 16.666
      this.lastFrameTime = time

      this.update(dt, time)
      this.render(time)

      requestAnimationFrame(loop)
    }

    requestAnimationFrame(loop)
  }

  syncLayout() {
    this.resize()
    this.goToLevel(this.level, { keepLevel: true })
  }

  bindEvents() {
    window.addEventListener('resize', () => {
      this.syncLayout()
    })

    this.canvas.addEventListener('mousedown', (event) => this.onPointerDown(event))
    this.canvas.addEventListener('mousemove', (event) => this.onPointerMove(event))
    window.addEventListener('mouseup', (event) => this.onPointerUp(event))
    window.addEventListener('blur', () => this.stopDrawing())

    this.ui.launchBtn.addEventListener('click', () => this.launchProbe())
    this.ui.clearBtn.addEventListener('click', () => this.resetCurrentLevel())
    this.ui.hintBtn.addEventListener('click', () => this.toggleHint())
    this.ui.retryBtn.addEventListener('click', () => this.resetCurrentLevel())

    this.lineTypeEls.adhesion = document.querySelector('#lineTypeAdhesion')
    this.lineTypeEls.bounce = document.querySelector('#lineTypeBounce')
    this.lineTypeEls.adhesion.addEventListener('click', () => this.setSelectedLineType('adhesion'))
    this.lineTypeEls.bounce.addEventListener('click', () => this.setSelectedLineType('bounce'))

    window.addEventListener('keydown', (event) => {
      if (event.key === '1') this.setSelectedLineType('adhesion')
      if (event.key === '2') this.setSelectedLineType('bounce')
    })
  }

  resize() {
    this.width = Math.max(320, window.innerWidth)
    this.height = Math.max(480, window.innerHeight)
    this.dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))

    this.canvas.width = Math.floor(this.width * this.dpr)
    this.canvas.height = Math.floor(this.height * this.dpr)
    this.canvas.style.width = `${this.width}px`
    this.canvas.style.height = `${this.height}px`

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  createStarfield(count, seed = 24, hues = [180, 195, 210, 265]) {
    const rng = createRng(seed)
    return Array.from({ length: count }, () => ({
      x: rng.next(),
      y: rng.next(),
      z: rng.range(0.2, 1),
      size: rng.range(0.6, 2.2),
      phase: rng.range(0, Math.PI * 2),
      drift: rng.range(0.05, 0.28),
      twinkle: rng.range(0.4, 1.4),
      hue: rng.pick(hues),
    }))
  }

  createCosmicBackdrop(seed, mode, start = null, goal = null) {
    const rng = createRng(seed * 991 + (mode === 'tutorial' ? 17 : 83))
    const palettes = [
      {
        baseTop: 'rgba(1, 3, 10, 1)',
        baseMid: 'rgba(2, 7, 20, 1)',
        baseBottom: 'rgba(4, 8, 18, 1)',
        nebula: ['rgba(76, 243, 255, 0.12)', 'rgba(177, 108, 255, 0.1)'],
        starHues: [180, 195, 210, 265],
      },
      {
        baseTop: 'rgba(4, 4, 14, 1)',
        baseMid: 'rgba(12, 6, 24, 1)',
        baseBottom: 'rgba(8, 4, 18, 1)',
        nebula: ['rgba(255, 176, 77, 0.1)', 'rgba(255, 88, 114, 0.08)'],
        starHues: [28, 36, 52, 332],
      },
      {
        baseTop: 'rgba(2, 7, 13, 1)',
        baseMid: 'rgba(4, 18, 24, 1)',
        baseBottom: 'rgba(2, 10, 18, 1)',
        nebula: ['rgba(86, 255, 181, 0.1)', 'rgba(72, 230, 255, 0.1)'],
        starHues: [156, 180, 200, 212],
      },
    ]
    const palette = palettes[rng.int(0, palettes.length - 1)]
    const stars = this.createStarfield(mode === 'tutorial' ? 220 : 280, seed + 11, palette.starHues)

    const safeSpot = (minX, maxX, minY, maxY) => {
      for (let i = 0; i < 30; i += 1) {
        const x = rng.range(minX, maxX)
        const y = rng.range(minY, maxY)
        if (!start || distance({ x, y }, start) > 160) {
          if (!goal || distance({ x, y }, goal) > 160) {
            return { x, y }
          }
        }
      }
      return { x: rng.range(minX, maxX), y: rng.range(minY, maxY) }
    }

    const nebulae = Array.from({ length: rng.int(3, 5) }, (_, index) => {
      const spot = safeSpot(this.width * 0.08, this.width * 0.92, this.height * 0.1, this.height * 0.88)
      return {
        x: spot.x,
        y: spot.y,
        rx: rng.range(this.width * 0.09, this.width * 0.24),
        ry: rng.range(this.height * 0.08, this.height * 0.2),
        angle: rng.range(0, Math.PI),
        blur: rng.range(22, 58),
        alpha: rng.range(0.05, 0.14),
        color: palette.nebula[index % palette.nebula.length],
      }
    })

    const dustBands = Array.from({ length: rng.int(1, 3) }, () => {
      const a = safeSpot(this.width * 0.06, this.width * 0.9, this.height * 0.06, this.height * 0.92)
      const b = safeSpot(this.width * 0.1, this.width * 0.94, this.height * 0.08, this.height * 0.9)
      return {
        a,
        b,
        thickness: rng.range(1.5, 4.5),
        alpha: rng.range(0.04, 0.12),
        color: rng.pick(palette.nebula),
      }
    })

    const galaxy = rng.next() > 0.35
      ? {
          x: rng.range(this.width * 0.28, this.width * 0.72),
          y: rng.range(this.height * 0.18, this.height * 0.52),
          radius: rng.range(this.width * 0.08, this.width * 0.18),
          angle: rng.range(0, Math.PI * 2),
          alpha: rng.range(0.04, 0.09),
          color: rng.pick(palette.nebula),
        }
      : null

    const meteors = Array.from({ length: rng.int(2, 4) }, () => {
      const spot = safeSpot(this.width * 0.08, this.width * 0.9, this.height * 0.08, this.height * 0.9)
      return {
        x: spot.x,
        y: spot.y,
        length: rng.range(40, 110),
        angle: rng.range(-Math.PI * 0.75, Math.PI * 0.75),
        speed: rng.range(0.04, 0.12),
        alpha: rng.range(0.05, 0.11),
        color: rng.pick(palette.nebula),
        phase: rng.range(0, Math.PI * 2),
      }
    })

    return {
      palette,
      stars,
      nebulae,
      dustBands,
      galaxy,
      meteors,
    }
  }

  makeCosmicTheme(seed, mode, start = null, goal = null) {
    return this.createCosmicBackdrop(seed, mode, start, goal)
  }

  setTutorialPages(pages) {
    this.tutorialPages = pages.slice()
  }

  setScene(mode) {
    this.sceneMode = mode
    this.inputLocked = mode === 'menu' || this.paused || this.tutorialLocked
  }

  setPaused(paused) {
    this.paused = paused
    this.inputLocked = this.paused || this.tutorialLocked || this.sceneMode === 'menu'
  }

  setInputLocked(locked) {
    this.tutorialLocked = locked
    this.inputLocked = locked || this.paused || this.sceneMode === 'menu'
  }

  startTutorialMode() {
    this.sceneMode = 'tutorial'
    this.currentLevelSeed = 1
    this.autoRefreshEnabled = false
    this.hintVisible = false
    this.hintUntil = 0
    this.ui.hintBtn.classList.remove('is-active')
    this.ui.hintBtn.textContent = '[提示]'
    this.setInputLocked(true)
    this.goToLevel(1)
  }

  startInfiniteMode(level = 1) {
    this.sceneMode = 'infinite'
    this.currentLevelSeed = level
    this.autoRefreshEnabled = true
    this.hintVisible = false
    this.hintUntil = 0
    this.ui.hintBtn.classList.remove('is-active')
    this.ui.hintBtn.textContent = '[提示]'
    this.setInputLocked(false)
    this.goToLevel(level)
  }

  refreshLevel() {
    if (this.sceneMode !== 'infinite') return
    this.currentLevelSeed = Math.max(1, this.currentLevelSeed + 1)
    this.goToLevel(this.currentLevelSeed, { keepLevel: false })
  }

  restartCurrentLevel() {
    this.goToLevel(this.level, { keepLevel: false })
  }

  toggleHint() {
    this.hintVisible = !this.hintVisible
    this.hintUntil = this.hintVisible ? performance.now() + 999999 : 0
    this.ui.hintBtn.classList.toggle('is-active', this.hintVisible)
    this.ui.hintBtn.textContent = this.hintVisible ? '[隐藏提示]' : '[提示]'
  }

  advanceLevel() {
    if (this.sceneMode === 'tutorial') {
      this.onEnterTutorial?.()
      return
    }
    this.currentLevelSeed = this.level + 1
    this.goToLevel(this.currentLevelSeed)
    this.state = 'ready'
  }

  goToLevel(level, { keepLevel = false } = {}) {
    this.level = level
    this.destroyWorld()

    if (this.sceneMode === 'tutorial') {
      this.levelData = this.createTutorialLevel()
    } else {
      this.levelData = this.createProceduralLevel(level)
    }

    this.buildLevel(this.levelData)
    this.hideOverlay()
    this.ui.levelText.textContent = String(this.level)
    this.ui.levelText.style.display = this.sceneMode === 'infinite' ? 'block' : 'block'
    this.updateEnergyUI()
  }

  destroyWorld() {
    Composite.clear(this.world, false)
    this.drawnSegments = []
    this.drawnBodies = []
    this.planets = []
    this.speedRings = []
    this.asteroids = []
    this.goldPath = []
    this.pathGuideSegments = []
    this.particles = []
    this.probeTrail = []
    this.planetGravityPulse.clear()
    this.gravityMitigation = null
    this.wallContacts.clear()
    this.strokes.clear()
    this.activeRail = null
    this.railCooldown = null
    this.state = 'ready'
    this.winAt = 0
    this.pendingNextLevelAt = 0
    this.failReason = ''
    this.hintVisible = false
    this.hintUntil = 0
    this.lastResult = null
    this.ui.hintBtn.classList.remove('is-active')
    this.ui.hintBtn.textContent = '[提示]'
    this.hideOverlay()
    this.wallContacts.clear()
    this.strokes.clear()
    this.activeRail = null
    this.railCooldown = null
    this.planetGravityPulse.clear()
    this.gravityMitigation = null
  }

  buildLevel(data) {
    this.energyMax = Math.max(360, data.energyMax)
    this.energy = this.energyMax

    const startSensor = Bodies.circle(data.start.x, data.start.y, 26, {
      isStatic: true,
      isSensor: true,
      label: 'start',
      render: { visible: false },
    })
    startSensor.gameType = 'start'

    const probe = Bodies.circle(data.start.x, data.start.y, PROBE_RADIUS, {
      isStatic: true,
      frictionAir: PROBE_AIR_DRAG,
      friction: 0,
      frictionStatic: 0,
      restitution: 0,
      density: 0.003,
      label: 'probe',
    })
    probe.gameType = 'probe'

    const wormhole = Bodies.circle(data.goal.x, data.goal.y, 30, {
      isStatic: true,
      isSensor: true,
      label: 'wormhole',
      render: { visible: false },
    })
    wormhole.gameType = 'wormhole'

    this.start = { ...data.start }
    this.goal = { ...data.goal }
    this.backgroundTheme = this.makeCosmicTheme(data.seed || this.level, this.sceneMode, this.start, this.goal)
    this.stars = this.backgroundTheme.stars
    this.probe = probe
    this.startPortal = startSensor
    this.wormhole = wormhole
    this.goldPath = data.goldPath || []
    this.pathGuideSegments = data.pathGuideSegments || []

    const bodies = [startSensor, probe, wormhole]
    for (const planet of data.planets) {
      const body = Bodies.circle(planet.x, planet.y, planet.radius, {
        isStatic: true,
        label: 'planet',
        render: { visible: false },
      })
      body.gameType = 'planet'
      body.radius = planet.radius
      body.gravityRadius = planet.gravityRadius
      body.gravityStrength = planet.gravityStrength
      body.glowColor = planet.glowColor
      body.tint = planet.tint
      body.data = planet
      this.planets.push(body)
      bodies.push(body)
    }

    for (const ring of data.speedRings) {
      const body = Bodies.rectangle(ring.x, ring.y, ring.width, ring.height, {
        isStatic: true,
        isSensor: true,
        angle: ring.angle,
        label: 'speedRing',
        render: { visible: false },
      })
      body.gameType = 'speedRing'
      body.impulse = ring.impulse
      body.direction = ring.direction
      body.hue = ring.hue
      this.speedRings.push(body)
      bodies.push(body)
    }

    for (const asteroid of data.asteroids) {
      const body = Bodies.polygon(asteroid.x, asteroid.y, asteroid.sides, asteroid.radius, {
        isStatic: true,
        label: 'asteroid',
        render: { visible: false },
      })
      body.gameType = 'asteroid'
      body.tint = asteroid.tint
      this.asteroids.push(body)
      bodies.push(body)
    }

    Composite.add(this.world, bodies)
    this.probeTrail = []
    this.state = 'ready'
    this.setProbeAtStart()
    this.updateOverlayForState()
  }

  createTutorialLevel() {
    const start = { x: this.width * 0.14, y: this.height * 0.56 }
    const goal = { x: this.width * 0.84, y: this.height * 0.42 }
    const planet = {
      x: this.width * 0.48,
      y: this.height * 0.57,
      radius: Math.min(54, Math.max(38, this.height * 0.06)),
      gravityRadius: Math.min(this.width, this.height) * 0.24,
      gravityStrength: 0.00008,
      glowColor: 'rgba(66, 236, 255, 0.92)',
      tint: 'rgba(1, 10, 18, 0.96)',
    }

    const ring = {
      x: this.width * 0.58,
      y: this.height * 0.38,
      width: 130,
      height: 22,
      angle: -0.16,
      impulse: 0.0016,
      direction: 0,
      hue: 54,
    }

    return {
      kind: 'tutorial',
      seed: 1,
      start,
      goal,
      energyMax: 900,
      planets: [planet],
      speedRings: [ring],
      asteroids: [],
      goldPath: [
        { x: start.x, y: start.y },
        { x: this.width * 0.32, y: this.height * 0.34 },
        { x: this.width * 0.56, y: this.height * 0.64 },
        { x: goal.x, y: goal.y },
      ],
      pathGuideSegments: [],
      lineRoute: 'adhesion',
    }
  }

  createProceduralLevel(level) {
    const rng = createRng(level * 1337 + 42)
    const start = {
      x: clamp(this.width * rng.range(0.11, 0.18), 70, this.width * 0.22),
      y: clamp(this.height * rng.range(0.22, 0.78), 70, this.height - 70),
    }
    const goal = {
      x: clamp(this.width * rng.range(0.78, 0.9), this.width * 0.72, this.width - 72),
      y: clamp(this.height * rng.range(0.2, 0.8), 70, this.height - 70),
    }

    const dx = goal.x - start.x
    const dy = goal.y - start.y
    const cp1 = {
      x: start.x + dx * 0.26 + rng.range(-50, 30),
      y: start.y + dy * 0.14 + rng.range(-this.height * 0.22, this.height * 0.22),
    }
    const cp2 = {
      x: goal.x - dx * 0.24 + rng.range(-30, 50),
      y: goal.y - dy * 0.14 + rng.range(-this.height * 0.22, this.height * 0.22),
    }

    const goldPath = []
    const pathTangent = []
    const pathNormal = []
    const sampleCount = 90
    for (let i = 0; i < sampleCount; i += 1) {
      const t = i / (sampleCount - 1)
      const point = cubicBezierPoint(start, cp1, cp2, goal, t)
      const tangent = cubicBezierTangent(start, cp1, cp2, goal, t)
      goldPath.push(point)
      pathTangent.push(tangent)
      pathNormal.push({ x: -tangent.y, y: tangent.x })
    }

    const planetCount = rng.int(2, 4)
    const planetSpecs = []
    const speedRings = []
    const pathGuideSegments = []

    const pathForces = pathNormal.map((normal, index) => {
      const point = goldPath[index]
      let forceX = 0
      let forceY = 0
      for (let i = 0; i < planetCount; i += 1) {
        const angle = (i + 1) / (planetCount + 1) * Math.PI * 0.9 + level * 0.12
        const offset = 92 + i * 34 + rng.range(-14, 18)
        const side = i % 2 === 0 ? 1 : -1
        const planetRadius = rng.range(28, 48)
        const px = point.x + normal.x * side * offset + Math.cos(angle) * 18
        const py = point.y + normal.y * side * offset + Math.sin(angle) * 18
        const dx = px - point.x
        const dy = py - point.y
        const r = Math.hypot(dx, dy) || 1
        const strength = rng.range(0.000045, 0.00009) * (1 + i * 0.12)
        const falloff = 1 / Math.max(r * r, 1600)
        const force = strength * falloff * (planetRadius * 130000)
        forceX += (dx / r) * force
        forceY += (dy / r) * force
      }
      return { x: forceX, y: forceY }
    })
    const pathLength = Math.max(300, polylineLength(goldPath))
    const adhesionSegments = this.buildAdhesionRouteSegments(goldPath, pathNormal, pathForces)

    const computePressSide = (index) => {
      const tangent = pathTangent[index]
      const normal = pathNormal[index]
      const force = pathForces[index]
      const push = force.x * normal.x + force.y * normal.y
      if (Math.abs(push) < 0.0003) return push >= 0 ? 1 : -1
      return push > 0 ? 1 : -1
    }

    const makePlanet = (index, side) => {
      const point = goldPath[index]
      const normal = pathNormal[index]
      const tangent = pathTangent[index]
      const radius = rng.range(28, 48)
      const distanceFromPath = rng.range(88, 150)
      const candidate = {
        x: point.x + normal.x * side * distanceFromPath,
        y: point.y + normal.y * side * distanceFromPath,
        radius,
        gravityRadius: radius * rng.range(3.2, 4.2) + 84,
        gravityStrength: rng.range(0.000045, 0.00009),
        glowColor: rng.pick(['rgba(66, 236, 255, 0.9)', 'rgba(255, 166, 78, 0.92)']),
        tint: 'rgba(2, 6, 16, 0.98)',
        tangent,
      }
      return candidate
    }

    const sampleIndices = [14, 28, 46, 64, 78]
    for (let i = 0; i < planetCount; i += 1) {
      const index = sampleIndices[i] ?? rng.int(10, sampleCount - 12)
      const side = computePressSide(index)
      planetSpecs.push(makePlanet(index, side))
    }

    pathGuideSegments.push(...adhesionSegments)

    const planets = []
    for (const planet of planetSpecs) {
      planets.push(planet)
    }

    const ringFractions = [0.24, 0.48, 0.74].slice(0, rng.int(2, 3))
    for (const fraction of ringFractions) {
      const index = Math.round((sampleCount - 1) * fraction)
      const point = goldPath[index]
      const tangent = pathTangent[index]
      speedRings.push({
        x: point.x + tangent.x * 0,
        y: point.y + tangent.y * 0,
        width: rng.range(96, 138),
        height: rng.range(18, 26),
        angle: Math.atan2(tangent.y, tangent.x),
        impulse: rng.range(0.0014, 0.0021),
        direction: Math.atan2(tangent.y, tangent.x),
        hue: 52,
      })
    }

    const asteroids = []
    const asteroidCount = rng.int(3, 5)
    let tries = 0
    while (asteroids.length < asteroidCount && tries < 80) {
      tries += 1
      const x = rng.range(this.width * 0.18, this.width * 0.95)
      const y = rng.range(this.height * 0.08, this.height * 0.92)
      const radius = rng.range(18, 32)
      const candidate = { x, y, radius }
      const distToPath = Math.min(...goldPath.map((p) => distance(candidate, p)))
      const awayFromEndpoints = distance(candidate, start) > 140 && distance(candidate, goal) > 140
      const farEnough = distToPath > 125
      const notInPlanetField = planets.every((planet) => distance(candidate, planet) > planet.gravityRadius * 0.65)
      if (awayFromEndpoints && farEnough && notInPlanetField) {
        const silhouetteRng = createRng(level * 911 + x * 7 + y * 13 + radius * 19)
        asteroids.push({
          x,
          y,
          radius,
          sides: rng.int(5, 7),
          tint: 'rgba(95, 16, 24, 0.94)',
          silhouette: createRockSilhouette(silhouetteRng, radius, rng.int(8, 12)),
          glow: rng.pick(['rgba(255, 109, 122, 0.72)', 'rgba(255, 176, 77, 0.68)', 'rgba(76, 243, 255, 0.56)']),
        })
      }
    }

    return {
      kind: 'procedural',
      seed: level,
      start,
      goal,
      energyMax: this.computeAdhesionEnergyBudget(adhesionSegments),
      planets,
      speedRings,
      asteroids,
      goldPath,
      pathGuideSegments,
      lineRoute: 'adhesion',
    }
  }

  buildAdhesionRouteSegments(path, normals, forces) {
    const segments = []
    for (let i = 1; i < path.length; i += 1) {
      const a = path[i - 1]
      const b = path[i]
      const normal = normals[i]
      const force = forces[i]
      const forceMag = Math.hypot(force.x, force.y)
      const curveMag = Math.abs((normals[i - 1]?.x || 0) * normal.y - (normals[i - 1]?.y || 0) * normal.x)
      const side = force.x * normal.x + force.y * normal.y >= 0 ? 1 : -1
      const offset = 16 + Math.min(12, forceMag * 32)
      const segment = {
        a: {
          x: a.x + normal.x * side * offset,
          y: a.y + normal.y * side * offset,
        },
        b: {
          x: b.x + normal.x * side * offset,
          y: b.y + normal.y * side * offset,
        },
        thickness: WALL_THICKNESS,
        lineType: 'adhesion',
      }
      segments.push(segment)
      if (forceMag > 0.09 || curveMag > 0.18) {
        segments.push({
          a: {
            x: a.x - normal.x * side * (offset + 14),
            y: a.y - normal.y * side * (offset + 14),
          },
          b: {
            x: b.x - normal.x * side * (offset + 14),
            y: b.y - normal.y * side * (offset + 14),
          },
          thickness: WALL_THICKNESS,
          lineType: 'adhesion',
        })
      }
    }
    return segments
  }

  computeAdhesionEnergyBudget(segments) {
    const total = segments.reduce((sum, segment) => sum + distance(segment.a, segment.b), 0)
    return Math.max(360, total * 1.2)
  }

  setProbeAtStart() {
    Body.setPosition(this.probe, this.start)
    Body.setVelocity(this.probe, { x: 0, y: 0 })
    Body.setAngularVelocity(this.probe, 0)
    Body.setAngle(this.probe, 0)
    Body.setStatic(this.probe, true)
    this.probeTrail = [{ ...this.start }]
  }

  launchProbe() {
    if (this.inputLocked) return
    if (this.state === 'won') return
    if (this.state === 'lost') {
      this.state = 'ready'
      this.setProbeAtStart()
      this.railCooldown = null
      this.wallContacts.clear()
    }
    if (this.state !== 'ready') return
    Body.setStatic(this.probe, false)
    Body.setVelocity(this.probe, { x: 0, y: 0 })
    const direction = normalize({
      x: this.goal.x - this.start.x,
      y: this.goal.y - this.start.y,
    })
    Body.setVelocity(this.probe, {
      x: direction.x * 1.7,
      y: direction.y * 0.4,
    })
    this.state = 'launched'
    this.updateOverlayForState()
  }

  resetCurrentLevel() {
    this.goToLevel(this.level, { keepLevel: true })
  }

  nextLevel() {
    this.goToLevel(this.level + 1)
  }

  stopDrawing() {
    this.pointer.drawing = false
    this.pointer.last = null
    this.pointer.active = null
    this.pointer.strokeId = null
    this.pointer.strokeIndex = 0
  }

  onPointerDown(event) {
    if (this.inputLocked || this.state === 'won' || this.state === 'lost') return
    if (this.energy <= 0) return
    const point = this.getPointerPoint(event)
    this.pointer.drawing = true
    this.pointer.last = point
    this.pointer.active = point
    this.pointer.strokeId = this.nextStrokeId
    this.nextStrokeId += 1
    this.pointer.strokeIndex = 0
    this.strokes.set(this.pointer.strokeId, {
      id: this.pointer.strokeId,
      points: [point],
      bodies: [],
      segmentLengths: [],
      cumulativeLengths: [0],
      totalLength: 0,
      lineType: this.selectedLineType,
    })
  }

  onPointerMove(event) {
    if (this.inputLocked || !this.pointer.drawing || this.energy <= 0) return
    const point = this.getPointerPoint(event)
    this.pointer.active = point

    if (!this.pointer.last) {
      this.pointer.last = point
      return
    }

    const d = distance(this.pointer.last, point)
    if (d < DRAW_THRESHOLD) return

    this.createLineSegment(this.pointer.last, point)
  }

  onPointerUp() {
    this.stopDrawing()
  }

  getPointerPoint(event) {
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: clamp((event.clientX - rect.left), 0, this.width),
      y: clamp((event.clientY - rect.top), 0, this.height),
    }
  }

  createLineSegment(a, b) {
    const len = distance(a, b)
    if (len < 4 || this.energy <= 0) return

    const actualLength = Math.min(len, this.energy)
    const t = actualLength / len
    const end = {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
    }

    const angle = Math.atan2(end.y - a.y, end.x - a.x)
    const type = LINE_TYPES[this.selectedLineType]
    const width = type.mode === 'bounce' ? 11 : 14
    const body = Bodies.rectangle((a.x + end.x) / 2, (a.y + end.y) / 2, actualLength, width, {
      isStatic: true,
      isSensor: true,
      friction: 0,
      frictionStatic: 0,
      frictionAir: 0,
      restitution: 0,
      label: 'line',
      render: { visible: false },
    })
    const stroke = this.strokes.get(this.pointer.strokeId)
    const strokeIndex = stroke ? stroke.bodies.length : 0
    body.gameType = 'line'
    body.lineType = type.key
    body.strokeId = stroke ? stroke.id : null
    body.strokeIndex = strokeIndex
    body.segmentLength = actualLength
    body.segmentWidth = width
    body.angle = angle
    Body.setAngle(body, angle)

    this.drawnSegments.push(body)
    this.drawnBodies.push(body)
    Composite.add(this.world, body)
    if (stroke) {
      stroke.points.push(end)
      stroke.bodies.push(body)
      stroke.segmentLengths.push(actualLength)
      stroke.cumulativeLengths.push(stroke.totalLength + actualLength)
      stroke.totalLength += actualLength
      stroke.lineType = type.key
      if (!this.drawnStrokes.includes(stroke)) {
        this.drawnStrokes.push(stroke)
      }
    }
    this.energy = Math.max(0, this.energy - actualLength * type.cost)
    this.pointer.last = end
    this.updateEnergyUI()

    if (this.energy <= 0) {
      this.stopDrawing()
    }
  }

  applyPlanetGravity() {
    if (!this.probe || this.probe.isStatic || this.state !== 'launched') return
    const velocity = this.probe.velocity
    const speed = Math.hypot(velocity.x, velocity.y)
    for (const planet of this.planets) {
      const dx = planet.position.x - this.probe.position.x
      const dy = planet.position.y - this.probe.position.y
      const r = Math.hypot(dx, dy)
      if (!r || r > planet.gravityRadius) continue

      const radiusRatio = clamp(1 - r / planet.gravityRadius, 0, 1)
      const influence = radiusRatio * radiusRatio
      const falloff = 1 / Math.max(r * r, 600)
      const radiusScale = Math.max(0.8, (planet.radius || 40) / 42)
      const force =
        planet.gravityStrength *
        influence *
        falloff *
        planet.gravityRadius *
        GRAVITY_FORCE_SCALE *
        radiusScale *
        this.gameConfig.planetGravityForceMultiplier

      const radial = { x: dx / r, y: dy / r }
      const tangent = { x: -radial.y, y: radial.x }
      const radialSpeed = velocity.x * radial.x + velocity.y * radial.y
      const tangentSpeed = velocity.x * tangent.x + velocity.y * tangent.y
      const pull = force * (1 + radiusRatio * 0.9)
      const swirl = force * (0.8 + radiusRatio * 1.35)

      Body.applyForce(this.probe, this.probe.position, {
        x: radial.x * pull - tangent.x * tangentSpeed * 0.00065 * swirl,
        y: radial.y * pull - tangent.y * tangentSpeed * 0.00065 * swirl,
      })

      if (speed > 0.01) {
        const bend = clamp(swirl * 0.0000018, 0, 0.0009)
        Body.setVelocity(this.probe, {
          x: velocity.x + (radial.x * pull - tangent.x * bend * speed * 140),
          y: velocity.y + (radial.y * pull - tangent.y * bend * speed * 140),
        })
      }

      this.planetGravityPulse.set(planet.id, performance.now() + 220)
    }
  }

  applyGravityMitigation() {
    if (!this.gravityMitigation || this.state !== 'launched' || this.activeRail) return
    const now = performance.now()
    if (now >= this.gravityMitigation.until) {
      this.gravityMitigation = null
      return
    }

    const velocity = this.probe?.velocity
    if (!velocity) return
    const speed = Math.hypot(velocity.x, velocity.y)
    if (speed < 0.01) return

    const ratio = clamp(1 - (this.gravityMitigation.until - now) / this.gravityMitigation.duration, 0, 1)
    const kick = 1 - ratio
    const boost = 1 + this.gravityMitigation.boost * (0.55 + 0.45 * kick)
    Body.setVelocity(this.probe, {
      x: velocity.x * boost,
      y: velocity.y * boost,
    })
  }

  handleCollisionStart(event) {
    if (!this.probe) return
    for (const pair of event.pairs) {
      const bodyA = pair.bodyA
      const bodyB = pair.bodyB
      const hitProbe = bodyA === this.probe || bodyB === this.probe
      if (!hitProbe) continue

      const other = bodyA === this.probe ? bodyB : bodyA

      if (other.gameType === 'wormhole' && this.state === 'launched') {
        this.winLevel()
        return
      }

      if (other.gameType === 'asteroid') {
        this.failLevel('陨石碎片击毁了探测器。')
        return
      }

      if (other.gameType === 'speedRing' && this.state === 'launched') {
        const velocity = this.probe.velocity
        const dir = normalize(
          Math.hypot(velocity.x, velocity.y) < 0.2
            ? { x: this.goal.x - this.start.x, y: this.goal.y - this.start.y }
            : velocity,
        )
        Body.applyForce(this.probe, this.probe.position, {
          x: dir.x * other.impulse * 240,
          y: dir.y * other.impulse * 240,
        })
        this.spawnBurst(this.probe.position.x, this.probe.position.y, 'rgba(255, 228, 107, 0.92)', 12)
        return
      }

      if (other.gameType === 'line' && this.state === 'launched') {
        this.resolveLineContact(other)
        return
      }
    }
  }

  resolveLineContact(lineBody) {
    if (this.activeRail) return
    const velocity = this.probe.velocity
    const speed = Math.hypot(velocity.x, velocity.y)
    if (speed < 0.01) return

    const wallAngle = lineBody.angle || 0
    const tangent = { x: Math.cos(wallAngle), y: Math.sin(wallAngle) }
    const normal = { x: -tangent.y, y: tangent.x }
    const vDotN = velocity.x * normal.x + velocity.y * normal.y
    const vDotT = velocity.x * tangent.x + velocity.y * tangent.y
    const absNormal = Math.abs(vDotN) / speed
    const contactKey = lineBody.id
    const previousDirection = this.wallContacts.get(contactKey)?.direction || 1
    const stroke = lineBody.strokeId ? this.strokes.get(lineBody.strokeId) : null
    if (
      this.railCooldown &&
      stroke &&
      this.railCooldown.strokeId === stroke.id &&
      this.railCooldown.until > performance.now()
    ) {
      return
    }

    if (lineBody.lineType === 'bounce' || absNormal > BOUNCE_ANGLE_THRESHOLD) {
      const reflected = {
        x: velocity.x - 2 * vDotN * normal.x,
        y: velocity.y - 2 * vDotN * normal.y,
      }
      const baseSpeed = Math.hypot(reflected.x, reflected.y)
      const boost = clamp(baseSpeed * 0.14 + 0.18, 0.22, 0.65)
      this.gravityMitigation = {
        boost,
        duration: 1400 + Math.min(600, speed * 120),
        until: performance.now() + 1400 + Math.min(600, speed * 120),
      }
      Body.setVelocity(this.probe, {
        x: reflected.x * (1.02 + boost * 0.12),
        y: reflected.y * (1.02 + boost * 0.12),
      })
      Body.setPosition(this.probe, {
        x: this.probe.position.x + normal.x * WALL_CONTACT_PUSH,
        y: this.probe.position.y + normal.y * WALL_CONTACT_PUSH,
      })
      this.wallContacts.delete(contactKey)
      if (this.activeRail && this.activeRail.strokeId === lineBody.strokeId) {
        this.clearActiveRail(lineBody.strokeId)
      }
      return
    }

    if (lineBody.lineType === 'adhesion' && stroke) {
      const direction = Math.sign(vDotT) || previousDirection
      this.beginAdhesionRail(stroke, lineBody, direction, vDotT, speed)
      this.snapToAdhesionRail()
      return
    }

    const direction = Math.sign(vDotT) || previousDirection
    const projectedSpeed = Math.max(Math.abs(vDotT), speed * 0.9)
    Body.setVelocity(this.probe, {
      x: tangent.x * projectedSpeed * direction * WALL_SLIDE_DAMPING,
      y: tangent.y * projectedSpeed * direction * WALL_SLIDE_DAMPING,
    })
    Body.setPosition(this.probe, {
      x: this.probe.position.x + normal.x * WALL_CONTACT_PUSH,
      y: this.probe.position.y + normal.y * WALL_CONTACT_PUSH,
    })
    this.wallContacts.set(contactKey, {
      mode: 'adhesion',
      tangent,
      normal,
      direction,
    })
  }

  winLevel() {
    if (this.state === 'won') return
    this.state = 'won'
    this.winAt = performance.now()
    const result = this.evaluateWin()
    this.lastResult = result
    this.spawnBurst(this.goal.x, this.goal.y, 'rgba(176, 108, 255, 0.98)', 72)
    this.spawnBurst(this.goal.x, this.goal.y, 'rgba(76, 243, 255, 0.82)', 36)
    this.showOverlay(
      '关卡完成',
      this.buildWinSummary(result),
    )
  }

  failLevel(reason) {
    if (this.state === 'won') return
    this.state = 'ready'
    this.failReason = reason
    this.setProbeAtStart()
    this.railCooldown = null
    this.wallContacts.clear()
    this.hideOverlay()
  }

  spawnBurst(x, y, color, count) {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2
      const speed = Math.random() * 3.5 + 0.6
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: Math.random() * 40 + 24,
        maxLife: 64,
        size: Math.random() * 2.8 + 1,
        color,
      })
    }
  }

  update(dt, time) {
    if (this.paused || this.sceneMode === 'menu') {
      Engine.update(this.engine, 0)
      this.updateParticles()
      this.updateStarDrift(time)
      this.updateEnergyUI()
      return
    }

    if (this.state !== 'lost') {
      if (this.activeRail) {
        this.advanceAdhesionRail(dt)
      } else {
        Engine.update(this.engine, dt)
      }
    } else {
      Engine.update(this.engine, dt * 0.5)
    }

    if (this.state === 'launched') {
      this.trackProbeTrail()
      if (!this.activeRail) {
        this.resolveWallProximity()
      }
    }

    if (this.railCooldown && time >= this.railCooldown.until) {
      this.railCooldown = null
    }

    this.updateParticles()
    this.updateStarDrift(time)
    this.updateEnergyUI()
    this.updateOverlayForState()

    if (this.state === 'launched' && this.probe) {
      const p = this.probe.position
      const margin = 120
      if (
        p.x < -margin ||
        p.x > this.width + margin ||
        p.y < -margin ||
        p.y > this.height + margin
      ) {
        this.failLevel('探测器已偏离安全区域。')
      }
    }

    if (this.pendingNextLevelAt && time >= this.pendingNextLevelAt) {
      this.pendingNextLevelAt = 0
      this.nextLevel()
    }

    if (this.state === 'ready' && this.probe) {
      this.probeTrail = [{ ...this.start }]
    }
  }

  resolveWallProximity() {
    if (!this.probe) return
    const velocity = this.probe.velocity
    const speed = Math.hypot(velocity.x, velocity.y)
    if (!speed || this.drawnBodies.length === 0) return

    let nearest = null
    let nearestDistance = Infinity
    let nearestT = 0
    let nearestNormal = null
    let nearestTangent = null

    for (const lineBody of this.drawnBodies) {
      const dx = lineBody.position.x - this.probe.position.x
      const dy = lineBody.position.y - this.probe.position.y
      const angle = lineBody.angle || 0
      const tangent = { x: Math.cos(angle), y: Math.sin(angle) }
      const normal = { x: -tangent.y, y: tangent.x }
      const halfLength = (lineBody.segmentLength || 0) * 0.5
      const t = clamp(dx * tangent.x + dy * tangent.y, -halfLength, halfLength)
      const px = lineBody.position.x + tangent.x * t
      const py = lineBody.position.y + tangent.y * t
      const distX = this.probe.position.x - px
      const distY = this.probe.position.y - py
      const dist = Math.hypot(distX, distY)
      if (dist < nearestDistance) {
        nearestDistance = dist
        nearest = lineBody
        nearestT = t
        nearestNormal = normal
        nearestTangent = tangent
      }
    }

    if (!nearest || nearestDistance > WALL_NEAR_DISTANCE) {
      this.wallContacts.clear()
      return
    }

    const vDotT = velocity.x * nearestTangent.x + velocity.y * nearestTangent.y
    const vDotN = velocity.x * nearestNormal.x + velocity.y * nearestNormal.y
    const absNormal = Math.abs(vDotN) / Math.max(speed, 0.0001)
    const lineType = nearest.lineType || 'adhesion'

    if (lineType === 'bounce' || absNormal > BOUNCE_ANGLE_THRESHOLD) {
      const reflected = {
        x: velocity.x - 2 * vDotN * nearestNormal.x,
        y: velocity.y - 2 * vDotN * nearestNormal.y,
      }
      Body.setVelocity(this.probe, {
        x: reflected.x,
        y: reflected.y,
      })
      Body.setPosition(this.probe, {
        x: this.probe.position.x + nearestNormal.x * WALL_CONTACT_PUSH,
        y: this.probe.position.y + nearestNormal.y * WALL_CONTACT_PUSH,
      })
      return
    }

    const closestPoint = this.getClosestPointOnLine(nearest, nearestTangent, nearestT)
    const previousDirection = this.wallContacts.get(nearest.id)?.direction || 1
    if (lineType === 'adhesion') {
      const stroke = nearest.strokeId ? this.strokes.get(nearest.strokeId) : null
      if (stroke && !this.isRailCoolingDown(stroke.id)) {
        this.beginAdhesionRail(stroke, nearest, Math.sign(vDotT) || previousDirection, vDotT, speed)
        this.snapToAdhesionRail()
      } else {
        const direction = Math.sign(vDotT) || previousDirection
        const projectedSpeed = Math.max(Math.abs(vDotT), speed * 0.9)
        Body.setPosition(this.probe, {
          x: closestPoint.x + nearestNormal.x * WALL_CONTACT_PUSH,
          y: closestPoint.y + nearestNormal.y * WALL_CONTACT_PUSH,
        })
        Body.setVelocity(this.probe, {
          x: nearestTangent.x * projectedSpeed * direction * WALL_SLIDE_DAMPING,
          y: nearestTangent.y * projectedSpeed * direction * WALL_SLIDE_DAMPING,
        })
        this.wallContacts.set(nearest.id, {
          mode: 'adhesion',
          tangent: nearestTangent,
          normal: nearestNormal,
          direction,
        })
      }
      return
    }

    Body.setPosition(this.probe, {
      x: closestPoint.x + nearestNormal.x * WALL_CONTACT_PUSH,
      y: closestPoint.y + nearestNormal.y * WALL_CONTACT_PUSH,
    })
    Body.setVelocity(this.probe, {
      x: nearestTangent.x * vDotT,
      y: nearestTangent.y * vDotT,
    })
  }

  getClosestPointOnLine(lineBody, tangent, halfLength = null) {
    const dx = this.probe.position.x - lineBody.position.x
    const dy = this.probe.position.y - lineBody.position.y
    const t = clamp(dx * tangent.x + dy * tangent.y, -Math.max(halfLength ?? (lineBody.segmentLength || 0) * 0.5, 0), Math.max(halfLength ?? (lineBody.segmentLength || 0) * 0.5, 0))
    return {
      x: lineBody.position.x + tangent.x * t,
      y: lineBody.position.y + tangent.y * t,
      t,
    }
  }

  getPointOnStrokeSegment(stroke, segmentIndex) {
    const a = stroke.points[segmentIndex]
    const b = stroke.points[segmentIndex + 1]
    if (!a || !b) return null
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    const rawT = lenSq === 0 ? 0 : ((this.probe.position.x - a.x) * dx + (this.probe.position.y - a.y) * dy) / lenSq
    const t = clamp(rawT, 0, 1)
    const point = {
      x: a.x + dx * t,
      y: a.y + dy * t,
    }
    const segmentLength = stroke.segmentLengths?.[segmentIndex] ?? Math.hypot(dx, dy)
    const progress = (stroke.cumulativeLengths?.[segmentIndex] ?? 0) + segmentLength * t
    return {
      segmentIndex,
      point,
      distance: distance(point, this.probe.position),
      tangent: normalize({ x: dx, y: dy }),
      normal: normalize({ x: -dy, y: dx }),
      localT: t,
      progress,
    }
  }

  getStrokePointAtDistance(stroke, distanceAlong) {
    const totalLength = stroke.totalLength || stroke.cumulativeLengths?.[stroke.cumulativeLengths.length - 1] || 0
    if (!stroke.points.length || totalLength <= 0) return null

    const target = clamp(distanceAlong, 0, totalLength)
    for (let i = 0; i < stroke.points.length - 1; i += 1) {
      const segStart = stroke.cumulativeLengths?.[i] ?? 0
      const segEnd = stroke.cumulativeLengths?.[i + 1] ?? segStart
      if (target <= segEnd || i === stroke.points.length - 2) {
        const a = stroke.points[i]
        const b = stroke.points[i + 1]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const span = Math.max(segEnd - segStart, 0)
        const localT = span > 0 ? clamp((target - segStart) / span, 0, 1) : 0
        const tangent = normalize({ x: dx, y: dy })
        return {
          segmentIndex: i,
          point: {
            x: a.x + dx * localT,
            y: a.y + dy * localT,
          },
          tangent,
          normal: { x: -tangent.y, y: tangent.x },
          localT,
          progress: target,
        }
      }
    }

    return null
  }

  beginAdhesionRail(stroke, lineBody, direction, entryDotT, entrySpeed) {
    const segmentIndex = Math.max(0, Math.min(lineBody.strokeIndex || 0, stroke.bodies.length - 1))
    const entry = this.getPointOnStrokeSegment(stroke, segmentIndex)
    if (!entry) return
    const offsetX = this.probe.position.x - entry.point.x
    const offsetY = this.probe.position.y - entry.point.y
    const offsetSign = Math.sign(offsetX * entry.normal.x + offsetY * entry.normal.y) || 1
    this.activeRail = {
      strokeId: stroke.id,
      progress: entry.progress,
      direction: direction || 1,
      speed: Math.max(Math.abs(entryDotT), entrySpeed * 0.9),
      offsetSign,
      sourceBodyId: lineBody.id,
    }
    Body.setStatic(this.probe, true)
    this.wallContacts.set(lineBody.id, {
      mode: 'rail',
      strokeId: stroke.id,
      segmentIndex,
      direction: direction || 1,
    })
  }

  snapToAdhesionRail() {
    if (!this.activeRail) return
    const stroke = this.strokes.get(this.activeRail.strokeId)
    if (!stroke || !stroke.bodies.length) return this.clearActiveRail()
    const currentPoint = this.getStrokePointAtDistance(stroke, this.activeRail.progress)
    if (!currentPoint) return this.clearActiveRail(stroke.id)
    this.applyRailContact(stroke, currentPoint)
  }

  applyRailContact(stroke, contact) {
    const direction = this.activeRail.direction || 1
    const offsetSign = this.activeRail.offsetSign || 1

    Body.setPosition(this.probe, {
      x: contact.point.x + contact.normal.x * WALL_CONTACT_PUSH * offsetSign,
      y: contact.point.y + contact.normal.y * WALL_CONTACT_PUSH * offsetSign,
    })
    Body.setVelocity(this.probe, { x: 0, y: 0 })
    const body = stroke.bodies[contact.segmentIndex]
    if (body) {
      this.wallContacts.set(body.id, {
        mode: 'rail',
        strokeId: stroke.id,
        segmentIndex: contact.segmentIndex,
        direction,
      })
    }
  }

  advanceAdhesionRail(dt) {
    if (!this.activeRail) return
    const stroke = this.strokes.get(this.activeRail.strokeId)
    if (!stroke || !stroke.bodies.length) return this.clearActiveRail()

    const step = this.activeRail.speed * (dt / 16.666)
    if (step <= 0) return

    if (this.activeRail.releasing) {
      const exit = this.activeRail.releaseExit
      if (!exit) return this.clearActiveRail(stroke.id)

      const move = Math.min(step, this.activeRail.releaseRemaining)
      const traveled = (this.activeRail.releaseTravel || 0) + move
      this.activeRail.releaseTravel = traveled
      this.activeRail.releaseRemaining -= move

      Body.setPosition(this.probe, {
        x: exit.point.x + exit.tangent.x * traveled * this.activeRail.direction,
        y: exit.point.y + exit.tangent.y * traveled * this.activeRail.direction,
      })
      Body.setVelocity(this.probe, {
        x: exit.tangent.x * this.activeRail.speed * this.activeRail.direction,
        y: exit.tangent.y * this.activeRail.speed * this.activeRail.direction,
      })

      if (this.activeRail.releaseRemaining <= 0) {
        return this.clearActiveRail(stroke.id, exit)
      }
      return
    }

    const current = this.getStrokePointAtDistance(stroke, this.activeRail.progress)
    if (!current) return this.clearActiveRail(stroke.id)

    const nextProgress = this.activeRail.progress + step * (this.activeRail.direction || 1)
    const endReached =
      (this.activeRail.direction || 1) > 0
        ? nextProgress >= stroke.totalLength
        : nextProgress <= 0

    if (endReached) {
      const exitPoint = this.getStrokePointAtDistance(
        stroke,
        (this.activeRail.direction || 1) > 0 ? stroke.totalLength : 0,
      )
      if (!exitPoint) return this.clearActiveRail(stroke.id)
      this.activeRail.progress = exitPoint.progress
      this.activeRail.releasing = true
      this.activeRail.releaseExit = exitPoint
      this.activeRail.releaseRemaining = WALL_ADHESION_RELEASE_DISTANCE
      this.activeRail.releaseTravel = 0
      this.applyRailContact(stroke, exitPoint)
      return
    }

    const nextPoint = this.getStrokePointAtDistance(stroke, nextProgress)
    if (!nextPoint) return this.clearActiveRail(stroke.id)
    this.activeRail.progress = nextProgress
    this.applyRailContact(stroke, nextPoint)
  }

  clearActiveRail(strokeId = null, exitPoint = null) {
    const rail = this.activeRail
    if (rail) {
      const stroke = this.strokes.get(rail.strokeId)
      const contact =
        exitPoint ||
        (stroke ? this.getStrokePointAtDistance(stroke, rail.progress) : null) ||
        rail.releaseExit ||
        null
      Body.setStatic(this.probe, false)
      if (contact) {
        Body.setVelocity(this.probe, {
          x: contact.tangent.x * rail.speed * rail.direction,
          y: contact.tangent.y * rail.speed * rail.direction,
        })
      }
    }
    if (strokeId) {
      this.railCooldown = {
        strokeId,
        until: performance.now() + 220,
      }
    }
    this.activeRail = null
    this.wallContacts.clear()
  }

  isRailCoolingDown(strokeId) {
    if (!this.railCooldown) return false
    if (performance.now() >= this.railCooldown.until) {
      this.railCooldown = null
      return false
    }
    return this.railCooldown.strokeId === strokeId
  }

  setSelectedLineType(type) {
    if (!LINE_TYPES[type]) return
    this.selectedLineType = type
    if (this.lineTypeEls.adhesion && this.lineTypeEls.bounce) {
      this.lineTypeEls.adhesion.classList.toggle('is-active', type === 'adhesion')
      this.lineTypeEls.bounce.classList.toggle('is-active', type === 'bounce')
    }
  }

  trackProbeTrail() {
    const point = { x: this.probe.position.x, y: this.probe.position.y }
    const last = this.probeTrail[this.probeTrail.length - 1]
    if (!last || distance(last, point) > 2) {
      this.probeTrail.push(point)
      if (this.probeTrail.length > MAX_TRAIL_POINTS) {
        this.probeTrail.shift()
      }
    }
  }

  updateParticles() {
    this.particles = this.particles
      .map((particle) => ({
        ...particle,
        x: particle.x + particle.vx,
        y: particle.y + particle.vy,
        vx: particle.vx * 0.98,
        vy: particle.vy * 0.98,
        life: particle.life - 1,
      }))
      .filter((particle) => particle.life > 0)
  }

  updateStarDrift(time) {
    this.starTime = time * 0.00006
  }

  updateEnergyUI() {
    const pct = clamp(this.energy / this.energyMax, 0, 1)
    this.ui.energyFill.style.transform = `scaleX(${pct})`
    this.ui.energyFill.style.opacity = String(0.8 + pct * 0.2)
  }

  updateOverlayForState() {
    if (this.state === 'lost') {
      this.showOverlay('任务失败', this.failReason || '请重试当前关卡。')
    }
  }

  evaluateWin() {
    const energyRatio = clamp(this.energy / this.energyMax, 0, 1)
    const pathScore = this.getPathEfficiencyScore()
    const speedBonus = this.state === 'won' && this.activeRail ? 0 : 1
    const rawScore = Math.round((energyRatio * 720 + pathScore * 280) * speedBonus)
    const score = clamp(rawScore, 120, 999)

    let stars = 1
    if (energyRatio >= 0.78 && pathScore >= 0.72) stars = 3
    else if (energyRatio >= 0.55 && pathScore >= 0.52) stars = 2

    if (this.energy <= this.energyMax * 0.15 && stars > 1) {
      stars = 1
    }

    return {
      score,
      stars,
      energyRatio,
      pathScore,
    }
  }

  getPathEfficiencyScore() {
    if (!this.goldPath.length || !this.probeTrail.length) return 0.5
    let total = 0
    for (const point of this.probeTrail) {
      let nearest = Infinity
      for (const guide of this.goldPath) {
        nearest = Math.min(nearest, distance(point, guide))
      }
      total += nearest
    }
    const avgDeviation = total / this.probeTrail.length
    return clamp(1 - avgDeviation / 180, 0, 1)
  }

  buildWinSummary(result) {
    const starText = '★'.repeat(result.stars) + '☆'.repeat(3 - result.stars)
    const energyPct = Math.round(result.energyRatio * 100)
    const pathPct = Math.round(result.pathScore * 100)
    const tail = this.sceneMode === 'infinite' ? '点击“下一关”进入下一个关卡。' : '教学关卡已完成。'
    return `评分 ${result.score} | ${starText} | 能量剩余 ${energyPct}% | 路线效率 ${pathPct}% | ${tail}`
  }

  showOverlay(title, body) {
    this.ui.statusTitle.textContent = title
    this.ui.statusBody.textContent = body
    this.ui.statusOverlay.classList.add('is-visible')
    const wonInfinite = this.sceneMode === 'infinite' && this.state === 'won'
    this.ui.nextBtn.classList.toggle('is-hidden', !wonInfinite)
    this.ui.retryBtn.classList.toggle('is-hidden', this.state !== 'lost')
    this.ui.backHomeBtn.classList.remove('is-hidden')
  }

  hideOverlay() {
    this.ui.statusOverlay.classList.remove('is-visible')
    this.ui.statusTitle.textContent = ''
    this.ui.statusBody.textContent = ''
    this.ui.nextBtn.classList.add('is-hidden')
    this.ui.retryBtn.classList.add('is-hidden')
  }

  render(time) {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.width, this.height)
    this.drawBackground(ctx, time)

    if (this.goldPath.length && this.hintVisible) {
      this.drawHintPath(ctx, time)
    }

    this.drawPlanets(ctx)
    this.drawAsteroids(ctx)
    this.drawSpeedRings(ctx, time)
    this.drawGuideSegments(ctx)
    this.drawStartPortal(ctx, time)
    this.drawWormhole(ctx, time)
    this.drawLines(ctx)
    this.drawProbeTrail(ctx)
    this.drawProbe(ctx)
    this.drawParticles(ctx)
    this.drawStateText(ctx)
    this.drawTutorialCopy(ctx)
  }

  drawBackground(ctx, time) {
    ctx.save()
    const theme = this.backgroundTheme || this.makeCosmicTheme(this.level, this.sceneMode, this.start, this.goal)
    const palette = theme.palette
    const background = ctx.createLinearGradient(0, 0, 0, this.height)
    background.addColorStop(0, palette.baseTop)
    background.addColorStop(0.55, palette.baseMid)
    background.addColorStop(1, palette.baseBottom)
    ctx.fillStyle = background
    ctx.fillRect(0, 0, this.width, this.height)

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const nebula of theme.nebulae) {
      ctx.translate(nebula.x, nebula.y)
      ctx.rotate(nebula.angle + time * 0.00002)
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(nebula.rx, nebula.ry))
      g.addColorStop(0, nebula.color.replace('0.1', String(Math.min(0.18, nebula.alpha + 0.05))))
      g.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.filter = `blur(${nebula.blur}px)`
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.ellipse(0, 0, nebula.rx, nebula.ry, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    }
    ctx.restore()

    ctx.save()
    for (const band of theme.dustBands) {
      ctx.strokeStyle = band.color
      ctx.lineWidth = band.thickness
      ctx.globalAlpha = band.alpha
      ctx.shadowBlur = 24
      ctx.shadowColor = band.color
      ctx.beginPath()
      ctx.moveTo(band.a.x, band.a.y)
      ctx.quadraticCurveTo(
        (band.a.x + band.b.x) * 0.5 + 40,
        (band.a.y + band.b.y) * 0.5 - 50,
        band.b.x,
        band.b.y,
      )
      ctx.stroke()
    }
    ctx.restore()

    if (theme.galaxy) {
      ctx.save()
      ctx.translate(theme.galaxy.x, theme.galaxy.y)
      ctx.rotate(theme.galaxy.angle + time * 0.00004)
      ctx.globalCompositeOperation = 'lighter'
      ctx.shadowBlur = 50
      ctx.shadowColor = theme.galaxy.color
      for (let i = 0; i < 3; i += 1) {
        ctx.strokeStyle = `rgba(255,255,255,${Math.max(0.02, theme.galaxy.alpha - i * 0.02)})`
        ctx.lineWidth = 1.2 + i * 0.8
        ctx.beginPath()
        ctx.arc(0, 0, theme.galaxy.radius * (0.45 + i * 0.18), 0, Math.PI * 1.7)
        ctx.stroke()
      }
      ctx.restore()
    }

    ctx.globalCompositeOperation = 'lighter'
    for (const star of this.stars) {
      const drift = this.starTime || 0
      const x = (star.x * this.width + Math.sin(time * 0.00008 + star.phase) * star.drift * 18 + drift * 10 * star.z) % this.width
      const y = (star.y * this.height + Math.cos(time * 0.00005 + star.phase) * star.drift * 9 + drift * 4 * star.z) % this.height
      const alpha = 0.12 + star.z * 0.42
      ctx.beginPath()
      ctx.fillStyle = `hsla(${star.hue}, 100%, 88%, ${alpha})`
      ctx.shadowBlur = 10 * star.z
      ctx.shadowColor = `hsla(${star.hue}, 100%, 75%, ${alpha})`
      ctx.arc(x, y, star.size * star.z, 0, Math.PI * 2)
      ctx.fill()
    }

    if (theme.meteors) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      for (const meteor of theme.meteors) {
        const px = meteor.x + Math.cos(time * 0.00012 * meteor.speed + meteor.phase) * 18
        const py = meteor.y + Math.sin(time * 0.00008 * meteor.speed + meteor.phase) * 10
        const dx = Math.cos(meteor.angle) * meteor.length
        const dy = Math.sin(meteor.angle) * meteor.length
        ctx.strokeStyle = meteor.color
        ctx.lineWidth = 1.8
        ctx.shadowBlur = 14
        ctx.shadowColor = meteor.color
        ctx.beginPath()
        ctx.moveTo(px, py)
        ctx.lineTo(px - dx, py - dy)
        ctx.stroke()
      }
      ctx.restore()
    }
    ctx.restore()
  }

  drawHintPath(ctx, time) {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const phase = (time || performance.now()) * 0.008
    for (let i = 1; i < this.goldPath.length; i += 1) {
      const a = this.goldPath[i - 1]
      const b = this.goldPath[i]
      const pulse = 0.22 + 0.18 * Math.sin(phase + i * 0.35)
      ctx.setLineDash([14, 12])
      ctx.lineDashOffset = -phase * 8
      ctx.lineCap = 'round'
      ctx.strokeStyle = `rgba(255, 228, 107, ${pulse})`
      ctx.shadowBlur = 18
      ctx.shadowColor = 'rgba(255, 228, 107, 0.46)'
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 0.7
    ctx.lineWidth = 1.4
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
    ctx.shadowBlur = 8
    ctx.shadowColor = 'rgba(255, 255, 255, 0.15)'
    ctx.beginPath()
    for (let i = 0; i < this.goldPath.length; i += 1) {
      const p = this.goldPath[i]
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
    ctx.restore()
  }

  drawStartPortal(ctx, time) {
    const pulse = 0.65 + Math.sin(time * 0.002) * 0.15
    ctx.save()
    ctx.translate(this.start.x, this.start.y)
    ctx.shadowBlur = 22
    ctx.shadowColor = `rgba(76, 243, 255, ${pulse})`
    ctx.strokeStyle = `rgba(76, 243, 255, ${0.65})`
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(0, 0, 18, 0, Math.PI * 2)
    ctx.stroke()
    this.drawArrow(ctx, 28, 0, 22)
    ctx.lineWidth = 10
    ctx.globalAlpha = 0.22
    ctx.beginPath()
    ctx.arc(0, 0, 10, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  drawWormhole(ctx, time) {
    const rot = time * 0.0012
    ctx.save()
    ctx.translate(this.goal.x, this.goal.y)
    ctx.rotate(rot)
    ctx.shadowBlur = 34
    ctx.shadowColor = 'rgba(176, 108, 255, 0.86)'
    for (let i = 0; i < 4; i += 1) {
      const radius = 12 + i * 8
      ctx.strokeStyle = `rgba(176, 108, 255, ${0.88 - i * 0.14})`
      ctx.lineWidth = i === 0 ? 4 : 2
      ctx.beginPath()
      ctx.arc(0, 0, radius, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 0.28
    ctx.fillStyle = 'rgba(176, 108, 255, 0.12)'
    ctx.beginPath()
    ctx.arc(0, 0, 9, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  drawGuideSegments(ctx) {
    if (!this.hintVisible) return
    for (const segment of this.pathGuideSegments) {
      const dx = segment.b.x - segment.a.x
      const dy = segment.b.y - segment.a.y
      const length = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx)
      ctx.save()
      ctx.translate(segment.a.x, segment.a.y)
      ctx.rotate(angle)
      ctx.shadowBlur = 18
      ctx.shadowColor = 'rgba(255, 228, 107, 0.38)'
      ctx.fillStyle = 'rgba(255, 228, 107, 0.08)'
      ctx.strokeStyle = 'rgba(255, 228, 107, 0.48)'
      ctx.lineWidth = 1.2
      ctx.setLineDash([8, 10])
      ctx.fillRect(0, -segment.thickness / 2, length, segment.thickness)
      ctx.strokeRect(0, -segment.thickness / 2, length, segment.thickness)
      ctx.restore()
    }
  }

  drawLineTypes(ctx) {
    // UI is HTML-based; no canvas rendering required here.
  }

  drawPlanets(ctx) {
    const now = performance.now()
    for (const planet of this.planets) {
      const { x, y } = planet.position
      ctx.save()
      ctx.translate(x, y)
      const radius = planet.radius
      const aura = planet.gravityRadius
      const shell = ctx.createRadialGradient(0, 0, radius * 0.12, 0, 0, radius * 1.8)
      shell.addColorStop(0, planet.coreColor || 'rgba(3, 8, 14, 0.98)')
      shell.addColorStop(0.45, planet.tint || 'rgba(7, 13, 24, 0.96)')
      shell.addColorStop(1, 'rgba(0, 0, 0, 0.12)')
      ctx.shadowBlur = 34
      ctx.shadowColor = planet.glowColor || 'rgba(76, 243, 255, 0.9)'
      ctx.fillStyle = shell
      ctx.beginPath()
      ctx.arc(0, 0, radius, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = planet.glowColor || 'rgba(76, 243, 255, 0.9)'
      ctx.lineWidth = 2.4
      ctx.beginPath()
      ctx.arc(0, 0, radius + 1.4, 0, Math.PI * 2)
      ctx.stroke()

      const pulseUntil = this.planetGravityPulse.get(planet.id) || 0
      if (pulseUntil > now) {
        const t = 1 - (pulseUntil - now) / 220
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.shadowBlur = 28 + 16 * (1 - t)
        ctx.shadowColor = 'rgba(255, 228, 107, 0.95)'
        ctx.strokeStyle = `rgba(255, 228, 107, ${0.32 + 0.55 * (1 - t)})`
        ctx.lineWidth = 2.8 + 4 * (1 - t)
        ctx.beginPath()
        ctx.arc(0, 0, aura + 10 + 12 * (1 - t), 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }

      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const auraGradient = ctx.createRadialGradient(0, 0, radius * 0.95, 0, 0, aura)
      auraGradient.addColorStop(0, 'rgba(0, 0, 0, 0)')
      auraGradient.addColorStop(0.72, 'rgba(255, 255, 255, 0.05)')
      auraGradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
      ctx.fillStyle = auraGradient
      ctx.beginPath()
      ctx.arc(0, 0, aura, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
      ctx.lineWidth = 1.35
      ctx.setLineDash([7, 9])
      ctx.shadowBlur = 0
      ctx.beginPath()
      ctx.arc(0, 0, planet.gravityRadius, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
      ctx.restore()
    }
  }

  drawSpeedRings(ctx, time) {
    for (const ring of this.speedRings) {
      const { x, y } = ring.position
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(ring.angle)
      ctx.shadowBlur = 20
      ctx.shadowColor = 'rgba(255, 228, 107, 0.88)'
      ctx.fillStyle = 'rgba(255, 228, 107, 0.16)'
      ctx.strokeStyle = 'rgba(255, 228, 107, 0.96)'
      ctx.lineWidth = 2
      const w = ring.width || 120
      const h = ring.height || 22
      ctx.fillRect(-w / 2, -h / 2, w, h)
      ctx.strokeRect(-w / 2, -h / 2, w, h)
      ctx.globalAlpha = 0.4 + Math.sin(time * 0.006) * 0.14
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
      ctx.strokeRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6)
      ctx.restore()
    }
  }

  drawAsteroids(ctx) {
    for (const asteroid of this.asteroids) {
      const verts = asteroid.silhouette || asteroid.vertices
      const centerX = asteroid.position?.x ?? asteroid.x
      const centerY = asteroid.position?.y ?? asteroid.y
      const radius = asteroid.circleRadius || asteroid.radius || 24
      ctx.save()
      ctx.translate(centerX, centerY)
      ctx.rotate((asteroid.angle || 0) * 0.18)
      ctx.shadowBlur = 26
      ctx.shadowColor = asteroid.glow || asteroid.tint || 'rgba(255, 80, 100, 0.6)'
      const surface = ctx.createRadialGradient(-radius * 0.18, -radius * 0.22, radius * 0.08, 0, 0, radius * 1.08)
      surface.addColorStop(0, 'rgba(255, 255, 255, 0.18)')
      surface.addColorStop(0.28, asteroid.tint || 'rgba(95, 16, 24, 0.96)')
      surface.addColorStop(1, 'rgba(10, 10, 18, 0.98)')
      ctx.fillStyle = surface
      ctx.strokeStyle = 'rgba(255, 200, 140, 0.2)'
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(verts[0].x, verts[0].y)
      for (let i = 1; i < verts.length; i += 1) {
        ctx.lineTo(verts[i].x, verts[i].y)
      }
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.shadowBlur = 0
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
      ctx.beginPath()
      ctx.ellipse(-radius * 0.18, -radius * 0.2, radius * 0.22, radius * 0.16, -0.35, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(76, 243, 255, 0.08)'
      ctx.beginPath()
      ctx.ellipse(radius * 0.05, radius * 0.1, radius * 0.68, radius * 0.42, 0.2, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
  }

  drawLines(ctx) {
    for (const body of this.drawnSegments) {
      const { x, y } = body.position
      const w = body.segmentLength
      const h = body.segmentWidth
      const type = LINE_TYPES[body.lineType] || LINE_TYPES.adhesion
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(body.angle)
      ctx.shadowBlur = 22
      ctx.shadowColor = type.glow
      ctx.fillStyle = body.lineType === 'bounce' ? 'rgba(255, 228, 107, 0.2)' : 'rgba(125, 255, 141, 0.2)'
      ctx.strokeStyle = type.color
      ctx.lineWidth = 2
      if (body.lineType === 'bounce') {
        ctx.beginPath()
        ctx.moveTo(-w / 2, 0)
        ctx.lineTo(w / 2, 0)
        ctx.stroke()
        ctx.fillStyle = type.color
        ctx.fillRect(-w / 2, -h * 0.17, w, h * 0.34)
        ctx.strokeRect(-w / 2, -h * 0.17, w, h * 0.34)
      } else {
        ctx.fillRect(-w / 2, -h / 2, w, h)
        ctx.strokeRect(-w / 2, -h / 2, w, h)
      }
      ctx.restore()
    }
  }

  drawProbeTrail(ctx) {
    if (this.probeTrail.length < 2) return
    ctx.save()
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    for (let i = 1; i < this.probeTrail.length; i += 1) {
      const a = this.probeTrail[i - 1]
      const b = this.probeTrail[i]
      const alpha = i / this.probeTrail.length
      ctx.strokeStyle = `rgba(76, 243, 255, ${alpha * 0.55})`
      ctx.shadowBlur = 12 * alpha
      ctx.shadowColor = 'rgba(76, 243, 255, 0.32)'
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.restore()
  }

  drawProbe(ctx) {
    if (!this.probe) return
    const { x, y } = this.probe.position
    ctx.save()
    ctx.shadowBlur = 22
    ctx.shadowColor = 'rgba(255, 255, 255, 0.98)'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.98)'
    ctx.beginPath()
    ctx.arc(x, y, PROBE_RADIUS, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 0.24
    ctx.fillStyle = 'rgba(76, 243, 255, 0.5)'
    ctx.beginPath()
    ctx.arc(x, y, PROBE_RADIUS + 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  drawParticles(ctx) {
    for (const particle of this.particles) {
      const alpha = clamp(particle.life / particle.maxLife, 0, 1)
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.shadowBlur = 18 * alpha
      ctx.shadowColor = particle.color
      ctx.fillStyle = particle.color
      ctx.beginPath()
      ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
  }

  drawStateText(ctx) {
    if (this.sceneMode === 'menu') {
      return
    }
    if (this.state === 'ready') {
      this.drawTextBlock(ctx, '绘制引力导轨', '拖动画出发光墙体，借助重力把探测器送往虫洞。', this.width * 0.5, this.height * 0.14, 'rgba(76, 243, 255, 0.9)')
    } else if (this.state === 'launched') {
      this.drawTextBlock(ctx, '探测器飞行中', '利用星球、加速环和你画出的墙体调整它的轨迹。', this.width * 0.5, this.height * 0.12, 'rgba(255, 228, 107, 0.82)')
    }
  }

  drawTutorialCopy(ctx) {
    if (this.level === 1) {
      ctx.save()
      ctx.font = `700 ${Math.max(24, Math.min(42, this.width * 0.034))}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
      ctx.shadowBlur = 18
      ctx.shadowColor = 'rgba(76, 243, 255, 0.28)'
      ctx.fillText('画出墙体，借助重力偏转探测器。', this.width * 0.5, this.height * 0.82)
      ctx.restore()
    }
  }

  drawTextBlock(ctx, title, body, x, y, color) {
    ctx.save()
    ctx.textAlign = 'center'
    ctx.shadowBlur = 14
    ctx.shadowColor = color
    ctx.fillStyle = color
    ctx.font = '700 16px ui-monospace, monospace'
    ctx.fillText(title, x, y)
    ctx.fillStyle = 'rgba(234, 248, 255, 0.72)'
    ctx.font = '400 12px ui-monospace, monospace'
    ctx.fillText(body, x, y + 18)
    ctx.restore()
  }

  drawArrow(ctx, x, y, length = 24) {
    ctx.save()
    ctx.translate(x, y)
    ctx.strokeStyle = 'rgba(255, 228, 107, 0.95)'
    ctx.fillStyle = 'rgba(255, 228, 107, 0.95)'
    ctx.lineWidth = 2
    ctx.shadowBlur = 12
    ctx.shadowColor = 'rgba(255, 228, 107, 0.85)'
    ctx.beginPath()
    ctx.moveTo(-length * 0.5, 0)
    ctx.lineTo(length * 0.5, 0)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(length * 0.5, 0)
    ctx.lineTo(length * 0.5 - 8, -6)
    ctx.lineTo(length * 0.5 - 8, 6)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
}
