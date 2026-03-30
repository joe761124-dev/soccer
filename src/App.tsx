import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Howl } from "howler";
import { 
  Trophy, 
  Music, 
  Play, 
  Gamepad2, 
  Zap, 
  Loader2,
  Volume2,
  VolumeX,
  Camera,
  RefreshCw,
  ChevronRight
} from "lucide-react";
import { GoogleGenAI } from "@google/genai";
import { cn } from "@/src/lib/utils";

// --- Constants & Config ---
const PITCH = { w: 800, h: 300, d: 400 };
const DRONE_RADIUS = 10;
const GOAL_INNER_RADIUS = 20;
const GOAL_TUBE_RADIUS = 3;
const TORUS_RADIUS = GOAL_INNER_RADIUS + GOAL_TUBE_RADIUS;
const GOAL_Y = 150;
const GOAL_X = PITCH.w / 2 - 100;

// --- Types ---
type Team = "red" | "blue";
type Role = "striker" | "defender";

// --- AI Initialization ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export default function App() {
  const [gameState, setGameState] = useState<"menu" | "playing" | "gameover">("menu");
  const [gameMode, setGameMode] = useState<"3v3" | "practice">("3v3");
  const [score, setScore] = useState({ red: 0, blue: 0 });
  const [timeLeft, setTimeLeft] = useState(180);
  const [isMuted, setIsMuted] = useState(false);
  const [bgMusicUrl, setBgMusicUrl] = useState<string | null>(null);
  const [isGeneratingMusic, setIsGeneratingMusic] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [stadiumImage, setStadiumImage] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    drones: Drone[];
    player: Drone | null;
    clock: THREE.Clock;
    frameId: number;
    goalPosRed: THREE.Vector3;
    goalPosBlue: THREE.Vector3;
    sfx: {
      score: Howl;
      collision: Howl;
      motor: Howl;
    };
  } | null>(null);

  const keys = useRef<{ [key: string]: boolean }>({});
  const joyLeft = useRef({ x: 0, y: 0 });
  const joyRight = useRef({ x: 0, y: 0 });

  // --- AI Functions ---
  const generateMusic = async () => {
    setIsGeneratingMusic(true);
    try {
      const response = await ai.models.generateContentStream({
        model: "lyria-3-clip-preview",
        contents: "Generate a 30-second high-energy futuristic electronic sports track for a drone soccer match. Fast tempo, synth-heavy, competitive vibe.",
      });

      let audioBase64 = "";
      let mimeType = "audio/wav";

      for await (const chunk of response) {
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (!parts) continue;
        for (const part of parts) {
          if (part.inlineData?.data) {
            if (!audioBase64 && part.inlineData.mimeType) {
              mimeType = part.inlineData.mimeType;
            }
            audioBase64 += part.inlineData.data;
          }
        }
      }

      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mimeType });
      const url = URL.createObjectURL(blob);
      setBgMusicUrl(url);
    } catch (error) {
      console.error("Music generation failed:", error);
    } finally {
      setIsGeneratingMusic(false);
    }
  };

  const generateStadiumTheme = async () => {
    setIsGeneratingImage(true);
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: {
          parts: [{ text: "A futuristic, neon-lit indoor sports stadium for drone soccer. High-tech arena, glowing goal rings, dark atmosphere with vibrant light trails, 4K resolution, cinematic lighting." }]
        },
        config: {
          imageConfig: {
            aspectRatio: "16:9",
            imageSize: "1K"
          }
        }
      });

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          setStadiumImage(`data:image/png;base64,${part.inlineData.data}`);
          break;
        }
      }
    } catch (error) {
      console.error("Image generation failed:", error);
    } finally {
      setIsGeneratingImage(false);
    }
  };

  // --- Game Classes ---
  class Drone {
    p: THREE.Vector3;
    prevP: THREE.Vector3;
    v: THREE.Vector3;
    yaw: number;
    radius: number = DRONE_RADIUS;
    mass: number = 1.0;
    color: number;
    role: Role;
    team: Team;
    speed: number = 1200;
    yawSpeed: number = 3.5;
    friction: number = 0.94;
    needsReset: boolean = false;
    stunTimer: number = 0;
    angularVelocity: THREE.Vector3 = new THREE.Vector3();
    group: THREE.Group;
    cageMesh: THREE.Mesh;
    coreMesh: THREE.Mesh;
    indicator?: THREE.Mesh;

    constructor(x: number, y: number, z: number, color: number, role: Role, team: Team, scene: THREE.Scene) {
      this.p = new THREE.Vector3(x, y, z);
      this.prevP = new THREE.Vector3(x, y, z);
      this.v = new THREE.Vector3(0, 0, 0);
      this.yaw = team === "red" ? -Math.PI / 2 : Math.PI / 2;
      this.color = color;
      this.role = role;
      this.team = team;

      this.group = new THREE.Group();
      
      // Cage
      const cageMat = new THREE.MeshStandardMaterial({ 
        color: 0x888888, 
        wireframe: true, 
        transparent: true, 
        opacity: 0.7,
        emissive: team === "red" ? 0x330000 : 0x000033,
        emissiveIntensity: 0.5
      });
      this.cageMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(DRONE_RADIUS, 2), cageMat);
      this.group.add(this.cageMesh);

      // Core
      const coreMat = new THREE.MeshStandardMaterial({ 
        color: color, 
        emissive: color, 
        emissiveIntensity: 0.8,
        metalness: 0.8,
        roughness: 0.2
      });
      this.coreMesh = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 16), coreMat);
      this.group.add(this.coreMesh);

      // LED Ring (14 LEDs)
      const numLEDs = 14;
      const ringRadius = DRONE_RADIUS + 0.5;
      for (let i = 0; i < numLEDs; i++) {
        const theta = i * (Math.PI * 2 / numLEDs);
        const lx = Math.sin(theta) * ringRadius;
        const lz = -Math.cos(theta) * ringRadius;
        const isBackLED = i >= 5 && i <= 9;
        const ledColor = team === "red" ? (isBackLED ? 0x5555ff : 0xff5555) : (isBackLED ? 0xff5555 : 0x5555ff);
        const ledMesh = new THREE.Mesh(
          new THREE.SphereGeometry(1.2, 8, 8),
          new THREE.MeshBasicMaterial({ color: ledColor })
        );
        ledMesh.position.set(lx, 0, lz);
        this.group.add(ledMesh);
      }

      if (role === "striker") {
        this.indicator = new THREE.Mesh(
          new THREE.SphereGeometry(2.5, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xffffff })
        );
        this.indicator.position.y = 13;
        this.group.add(this.indicator);
      }

      scene.add(this.group);
    }

    update(dt: number) {
      this.prevP.copy(this.p);
      if (this.stunTimer > 0) this.stunTimer -= dt;

      this.v.multiplyScalar(this.friction);
      this.p.addScaledVector(this.v, dt);

      // Bounds
      if (this.p.x - this.radius < -PITCH.w / 2) { this.p.x = -PITCH.w / 2 + this.radius; this.v.x *= -0.7; this.stunTimer = 0.1; }
      if (this.p.x + this.radius > PITCH.w / 2) { this.p.x = PITCH.w / 2 - this.radius; this.v.x *= -0.7; this.stunTimer = 0.1; }
      if (this.p.y - this.radius < 0) { this.p.y = this.radius; this.v.y *= -0.7; this.stunTimer = 0.1; }
      if (this.p.y + this.radius > PITCH.h) { this.p.y = PITCH.h - this.radius; this.v.y *= -0.7; this.stunTimer = 0.1; }
      if (this.p.z - this.radius < -PITCH.d / 2) { this.p.z = -PITCH.d / 2 + this.radius; this.v.z *= -0.7; this.stunTimer = 0.1; }
      if (this.p.z + this.radius > PITCH.d / 2) { this.p.z = PITCH.d / 2 - this.radius; this.v.z *= -0.7; this.stunTimer = 0.1; }

      this.group.position.copy(this.p);
      this.group.rotation.y = this.yaw;

      if (this.v.length() > 5 && this.angularVelocity.lengthSq() < 1) {
        const axis = new THREE.Vector3(this.v.z, 0, -this.v.x).normalize();
        this.cageMesh.rotateOnWorldAxis(axis, this.v.length() * dt * 0.04);
      }

      if (this.angularVelocity.lengthSq() > 0.01) {
        this.cageMesh.rotation.x += this.angularVelocity.x * dt;
        this.cageMesh.rotation.y += this.angularVelocity.y * dt;
        this.cageMesh.rotation.z += this.angularVelocity.z * dt;
        this.angularVelocity.multiplyScalar(0.9);
      }

      if (this.indicator) {
        (this.indicator.material as THREE.MeshBasicMaterial).color.setHex(this.needsReset ? 0x444444 : 0xffffff);
      }
    }

    destroy(scene: THREE.Scene) {
      scene.remove(this.group);
    }
  }

  // --- Game Loop & Logic ---
  const startGame = (mode: "3v3" | "practice") => {
    setGameMode(mode);
    setGameState("playing");
    setScore({ red: 0, blue: 0 });
    setTimeLeft(180);
    
    if (gameRef.current) {
      const { scene, drones } = gameRef.current;
      drones.forEach(d => d.destroy(scene));
      gameRef.current.drones = [];

      const redStriker = new Drone(-GOAL_X - 50, 30, 0, 0xff5555, "striker", "red", scene);
      gameRef.current.drones.push(redStriker);
      gameRef.current.player = redStriker;

      if (mode === "3v3") {
        gameRef.current.drones.push(new Drone(-GOAL_X - 50, 30, 80, 0xff5555, "defender", "red", scene));
        gameRef.current.drones.push(new Drone(-GOAL_X - 50, 30, -80, 0xff5555, "defender", "red", scene));
        gameRef.current.drones.push(new Drone(GOAL_X + 50, 30, 0, 0x5555ff, "striker", "blue", scene));
        gameRef.current.drones.push(new Drone(GOAL_X + 50, 30, 80, 0x5555ff, "defender", "blue", scene));
        gameRef.current.drones.push(new Drone(GOAL_X + 50, 30, -80, 0x5555ff, "defender", "blue", scene));
      }
      gameRef.current.clock.start();
    }
  };

  useEffect(() => {
    if (!canvasRef.current) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x05050a, 600, 2500);

    const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 3000);
    camera.position.set(-PITCH.w / 2 - 200, PITCH.h / 2 + 150, 0);
    camera.lookAt(0, PITCH.h / 2 - 50, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x05050a);
    renderer.shadowMap.enabled = true;
    canvasRef.current.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0x44ff44, 1, 1000);
    pointLight.position.set(0, PITCH.h, 0);
    scene.add(pointLight);

    // Floor
    const floorGeo = new THREE.PlaneGeometry(PITCH.w, PITCH.d);
    const floorMat = new THREE.MeshStandardMaterial({ 
      color: 0x111111, 
      roughness: 0.8,
      metalness: 0.2
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Grid on floor
    const grid = new THREE.GridHelper(1000, 20, 0x44ff44, 0x222222);
    grid.position.y = 0.1;
    scene.add(grid);

    // Goals
    const goalPosRed = new THREE.Vector3(-GOAL_X, GOAL_Y, 0);
    const goalPosBlue = new THREE.Vector3(GOAL_X, GOAL_Y, 0);

    const createGoal = (pos: THREE.Vector3, color: number) => {
      const geo = new THREE.TorusGeometry(TORUS_RADIUS, GOAL_TUBE_RADIUS, 16, 100);
      const mat = new THREE.MeshStandardMaterial({ 
        color: color, 
        emissive: color, 
        emissiveIntensity: 2.0 
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.rotation.y = Math.PI / 2;
      scene.add(mesh);

      const light = new THREE.PointLight(color, 1.5, 100);
      light.position.copy(pos);
      scene.add(light);
      
      return mesh;
    };

    createGoal(goalPosRed, 0xff5555);
    createGoal(goalPosBlue, 0x5555ff);

    // SFX
    const sfx = {
      score: new Howl({ src: ["https://assets.mixkit.co/sfx/preview/mixkit-arcade-game-jump-coin-216.mp3"] }),
      collision: new Howl({ src: ["https://assets.mixkit.co/sfx/preview/mixkit-metal-hit-clank-2144.mp3"] }),
      motor: new Howl({ src: ["https://assets.mixkit.co/sfx/preview/mixkit-robotic-mechanical-arm-movement-2401.mp3"], loop: true, volume: 0.1 })
    };

    gameRef.current = {
      scene,
      camera,
      renderer,
      drones: [],
      player: null,
      clock: new THREE.Clock(),
      frameId: 0,
      goalPosRed,
      goalPosBlue,
      sfx
    };

    const animate = () => {
      if (!gameRef.current) return;
      const { scene, camera, renderer, drones, player, clock, goalPosRed, goalPosBlue, sfx } = gameRef.current;
      
      const dt = Math.min(clock.getDelta(), 0.1);

      if (gameState === "playing") {
        // Player Input
        if (player && player.stunTimer <= 0) {
          let yawInput = 0;
          if (keys.current["a"]) yawInput += 1;
          if (keys.current["d"]) yawInput -= 1;
          yawInput -= joyLeft.current.x;
          player.yaw += yawInput * player.yawSpeed * dt;

          let throttleInput = 0;
          if (keys.current["w"]) throttleInput += 1;
          if (keys.current["s"]) throttleInput -= 1;
          throttleInput += joyLeft.current.y;
          player.v.y += throttleInput * player.speed * dt;

          const forwardVec = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)).normalize();
          const rightVec = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw)).normalize();

          let pitchInput = 0;
          if (keys.current["arrowup"]) pitchInput += 1;
          if (keys.current["arrowdown"]) pitchInput -= 1;
          pitchInput += joyRight.current.y;

          let rollInput = 0;
          if (keys.current["arrowleft"]) rollInput -= 1;
          if (keys.current["arrowright"]) rollInput += 1;
          rollInput += joyRight.current.x;

          player.v.addScaledVector(forwardVec, pitchInput * player.speed * dt);
          player.v.addScaledVector(rightVec, rollInput * player.speed * dt);

          if (throttleInput !== 0 || pitchInput !== 0 || rollInput !== 0) {
            if (!sfx.motor.playing()) sfx.motor.play();
          } else {
            sfx.motor.pause();
          }
        }

        // AI & Physics
        const timeNow = performance.now();
        drones.forEach(d => {
          if (d !== player && d.stunTimer <= 0) {
            if (d.role === "defender") {
              const myGoal = d.team === "red" ? goalPosRed : goalPosBlue;
              const enemyStriker = drones.find(ed => ed.team !== d.team && ed.role === "striker");
              if (enemyStriker) {
                let target = new THREE.Vector3().copy(myGoal).lerp(enemyStriker.p, 0.4);
                target.z += Math.sin(timeNow * 0.003 + d.p.x) * 25;
                target.y += Math.cos(timeNow * 0.004 + d.p.y) * 25;
                const dir = new THREE.Vector3().subVectors(target, d.p);
                if (dir.length() > 10) {
                  dir.normalize();
                  d.v.addScaledVector(dir, d.speed * dt * 0.6);
                  d.yaw = Math.atan2(-dir.x, -dir.z);
                }
              }
            } else if (d.role === "striker") {
              let target = new THREE.Vector3();
              if (d.needsReset) {
                target.set(d.team === "red" ? -200 : 200, GOAL_Y, 0);
              } else {
                target.copy(d.team === "red" ? goalPosBlue : goalPosRed);
              }
              let dir = new THREE.Vector3().subVectors(target, d.p).normalize();
              d.v.addScaledVector(dir, d.speed * dt * 0.55);
              d.yaw = Math.atan2(-dir.x, -dir.z);
            }
          }
        });

        // Collisions
        for (let i = 0; i < drones.length; i++) {
          const d1 = drones[i];
          d1.update(dt);
          
          for (let j = i + 1; j < drones.length; j++) {
            const d2 = drones[j];
            const diff = new THREE.Vector3().subVectors(d2.p, d1.p);
            const dist = diff.length();
            if (dist < d1.radius + d2.radius && dist > 0) {
              const overlap = (d1.radius + d2.radius) - dist;
              const normal = diff.clone().normalize();
              d1.p.addScaledVector(normal, -overlap * 0.5);
              d2.p.addScaledVector(normal, overlap * 0.5);
              const relVel = new THREE.Vector3().subVectors(d1.v, d2.v);
              const speed = relVel.dot(normal);
              const impulse = (1 + 0.8) * Math.max(speed, 350) / 2;
              d1.v.addScaledVector(normal, -impulse);
              d2.v.addScaledVector(normal, impulse);
              d1.stunTimer = 0.25;
              d2.stunTimer = 0.25;
              sfx.collision.play();
            }
          }

          // Goal Collision
          [goalPosRed, goalPosBlue].forEach(g => {
            const dx = d1.p.x - g.x;
            const dy = d1.p.y - g.y;
            const dz = d1.p.z - g.z;
            const distYZ = Math.hypot(dy, dz);
            const closestY = (dy / distYZ) * TORUS_RADIUS || TORUS_RADIUS;
            const closestZ = (dz / distYZ) * TORUS_RADIUS || 0;
            const distToRing = Math.hypot(dx, dy - closestY, dz - closestZ);
            if (distToRing < d1.radius + GOAL_TUBE_RADIUS) {
              const normal = new THREE.Vector3(dx, dy - closestY, dz - closestZ).normalize();
              d1.p.addScaledVector(normal, (d1.radius + GOAL_TUBE_RADIUS) - distToRing);
              d1.v.addScaledVector(normal, (1 + 0.6) * Math.max(-d1.v.dot(normal), 400));
              d1.stunTimer = 0.2;
              sfx.collision.play();
            }
          });

          // Scoring
          if (d1.role === "striker" && !d1.needsReset) {
            const tGoal = d1.team === "red" ? goalPosBlue : goalPosRed;
            const crossed = d1.team === "red" ? (d1.prevP.x <= tGoal.x && d1.p.x > tGoal.x) : (d1.prevP.x >= tGoal.x && d1.p.x < tGoal.x);
            if (crossed) {
              const dist = Math.hypot(d1.p.y - tGoal.y, d1.p.z - tGoal.z);
              if (dist < GOAL_INNER_RADIUS) {
                d1.needsReset = true;
                sfx.score.play();
                setScore(prev => {
                  const next = { ...prev };
                  if (d1.team === "red") next.red++;
                  else next.blue++;
                  return next;
                });
              }
            }
          }

          if (d1.role === "striker" && d1.needsReset) {
            if ((d1.team === "red" && d1.p.x < 0) || (d1.team === "blue" && d1.p.x > 0)) {
              d1.needsReset = false;
            }
          }
        }
      }

      renderer.render(scene, camera);
      gameRef.current!.frameId = requestAnimationFrame(animate);
    };

    animate();

    const handleKeyDown = (e: KeyboardEvent) => { keys.current[e.key.toLowerCase()] = true; };
    const handleKeyUp = (e: KeyboardEvent) => { keys.current[e.key.toLowerCase()] = false; };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    const handleResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("resize", handleResize);
      if (gameRef.current) cancelAnimationFrame(gameRef.current.frameId);
    };
  }, [gameState]);

  useEffect(() => {
    if (gameState === "playing") {
      const timer = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            setGameState("gameover");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [gameState]);

  // --- UI Components ---
  return (
    <div className="relative w-full h-screen overflow-hidden bg-black font-sans text-white select-none">
      {/* Game Canvas */}
      <div ref={canvasRef} className="absolute inset-0 z-0" />

      {/* Background Image (Stadium Theme) */}
      {stadiumImage && gameState === "menu" && (
        <div 
          className="absolute inset-0 z-[-1] opacity-40 blur-sm bg-cover bg-center"
          style={{ backgroundImage: `url(${stadiumImage})` }}
        />
      )}

      {/* UI Layer */}
      <div className="absolute inset-0 z-10 pointer-events-none flex flex-col">
        {/* Header / Scoreboard */}
        {gameState === "playing" && (
          <div className="p-6 flex justify-between items-start">
            <div className="bg-black/60 backdrop-blur-md border border-white/10 rounded-2xl p-4 flex items-center gap-6 pointer-events-auto">
              <div className="flex items-center gap-4">
                <div className="text-center">
                  <div className="text-[10px] uppercase tracking-widest text-red-400 font-bold">RED</div>
                  <div className="text-4xl font-black text-red-500 drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]">{score.red}</div>
                </div>
                <div className="text-2xl font-light text-white/30">/</div>
                <div className="text-center">
                  <div className="text-[10px] uppercase tracking-widest text-blue-400 font-bold">BLUE</div>
                  <div className="text-4xl font-black text-blue-500 drop-shadow-[0_0_10px_rgba(59,130,246,0.5)]">{score.blue}</div>
                </div>
              </div>
              <div className="h-10 w-px bg-white/10" />
              <div className="text-center min-w-[80px]">
                <div className="text-[10px] uppercase tracking-widest text-white/40 font-bold">TIME</div>
                <div className={cn(
                  "text-3xl font-mono font-bold",
                  timeLeft < 30 ? "text-yellow-400 animate-pulse" : "text-white"
                )}>
                  {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, "0")}
                </div>
              </div>
            </div>

            <div className="flex flex-col items-end gap-2">
              <div className={cn(
                "px-4 py-2 rounded-full text-xs font-bold tracking-widest uppercase border backdrop-blur-md",
                gameRef.current?.player?.needsReset 
                  ? "bg-yellow-500/20 border-yellow-500/50 text-yellow-400" 
                  : "bg-green-500/20 border-green-500/50 text-green-400"
              )}>
                {gameRef.current?.player?.needsReset ? "GOAL! RESET TO CENTER" : "READY TO STRIKE"}
              </div>
              <button 
                onClick={() => setIsMuted(!isMuted)}
                className="p-3 rounded-full bg-black/40 border border-white/10 pointer-events-auto hover:bg-white/10 transition-colors"
              >
                {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
              </button>
            </div>
          </div>
        )}

        {/* Menu Overlay */}
        {gameState === "menu" && (
          <div className="flex-1 flex flex-col items-center justify-center p-6 bg-black/40 backdrop-blur-sm pointer-events-auto">
            <div className="max-w-md w-full text-center space-y-8">
              <div className="space-y-2">
                <h1 className="text-6xl font-black italic tracking-tighter text-white uppercase">
                  Drone <span className="text-green-500">Soccer</span>
                </h1>
                <p className="text-white/40 text-sm tracking-[0.3em] uppercase font-bold">2026 Pro League Edition</p>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <button 
                  onClick={() => startGame("3v3")}
                  className="group relative overflow-hidden bg-white text-black font-black text-xl py-4 rounded-xl transition-transform active:scale-95"
                >
                  <div className="absolute inset-0 bg-green-500 translate-y-full group-hover:translate-y-0 transition-transform" />
                  <span className="relative z-10 flex items-center justify-center gap-3">
                    <Gamepad2 size={24} /> 3V3 COMPETITION
                  </span>
                </button>
                <button 
                  onClick={() => startGame("practice")}
                  className="bg-white/5 border border-white/10 hover:bg-white/10 font-bold text-lg py-4 rounded-xl transition-all active:scale-95 flex items-center justify-center gap-3"
                >
                  <Zap size={20} className="text-yellow-400" /> SOLO PRACTICE
                </button>
              </div>

              <div className="pt-8 border-t border-white/10 grid grid-cols-2 gap-4">
                <div className="space-y-3">
                  <div className="text-[10px] text-white/40 font-bold uppercase tracking-widest">AI Music Generator</div>
                  <button 
                    onClick={generateMusic}
                    disabled={isGeneratingMusic}
                    className="w-full bg-blue-500/20 border border-blue-500/50 hover:bg-blue-500/30 text-blue-400 py-3 rounded-lg text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isGeneratingMusic ? <Loader2 size={16} className="animate-spin" /> : <Music size={16} />}
                    {bgMusicUrl ? "REGENERATE TRACK" : "GENERATE MATCH MUSIC"}
                  </button>
                </div>
                <div className="space-y-3">
                  <div className="text-[10px] text-white/40 font-bold uppercase tracking-widest">AI Stadium Theme</div>
                  <button 
                    onClick={generateStadiumTheme}
                    disabled={isGeneratingImage}
                    className="w-full bg-purple-500/20 border border-purple-500/50 hover:bg-purple-500/30 text-purple-400 py-3 rounded-lg text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isGeneratingImage ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
                    {stadiumImage ? "CHANGE THEME" : "GENERATE STADIUM"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Game Over Overlay */}
        {gameState === "gameover" && (
          <div className="flex-1 flex flex-col items-center justify-center p-6 bg-black/80 backdrop-blur-xl pointer-events-auto">
            <div className="text-center space-y-8">
              <Trophy size={80} className="mx-auto text-yellow-500 animate-bounce" />
              <div className="space-y-2">
                <h2 className="text-5xl font-black uppercase italic">Match Finished</h2>
                <p className="text-white/40 font-bold tracking-widest">FINAL SCORE</p>
              </div>
              
              <div className="flex items-center justify-center gap-12">
                <div className="text-center">
                  <div className="text-6xl font-black text-red-500">{score.red}</div>
                  <div className="text-xs font-bold text-red-400/50 tracking-widest">RED TEAM</div>
                </div>
                <div className="text-4xl font-light text-white/20">VS</div>
                <div className="text-center">
                  <div className="text-6xl font-black text-blue-500">{score.blue}</div>
                  <div className="text-xs font-bold text-blue-400/50 tracking-widest">BLUE TEAM</div>
                </div>
              </div>

              <button 
                onClick={() => setGameState("menu")}
                className="bg-white text-black font-black px-12 py-4 rounded-full hover:scale-105 transition-transform flex items-center gap-3 mx-auto"
              >
                <RefreshCw size={20} /> RETURN TO MENU
              </button>
            </div>
          </div>
        )}

        {/* Controls Hint */}
        {gameState === "playing" && (
          <div className="mt-auto p-6 flex justify-center">
            <div className="bg-black/40 backdrop-blur-md border border-white/10 px-6 py-3 rounded-full text-[10px] font-bold tracking-widest text-white/60 flex gap-8 uppercase">
              <div className="flex items-center gap-2"><span className="text-green-400">WASD</span> ALTITUDE & YAW</div>
              <div className="flex items-center gap-2"><span className="text-green-400">ARROWS</span> PITCH & ROLL</div>
            </div>
          </div>
        )}
      </div>

      {/* Background Music Audio Element */}
      {bgMusicUrl && (
        <audio 
          src={bgMusicUrl} 
          autoPlay 
          loop 
          muted={isMuted || gameState !== "playing"} 
          ref={(el) => { if (el) el.volume = 0.4; }}
        />
      )}
    </div>
  );
}
