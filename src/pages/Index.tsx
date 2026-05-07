import { useState, useRef, useEffect, useCallback } from "react";
import Icon from "@/components/ui/icon";
import opentype from "opentype.js";

type Tab = "editor" | "preview" | "gallery";

interface Project {
  id: string;
  name: string;
  text: string;
  fontFamily: string;
  color: string;
  createdAt: Date;
}

const SAMPLE_PROJECTS: Project[] = [
  { id: "1", name: "Привет, мир!", text: "Привет, мир!", fontFamily: "Caveat", color: "#a855f7", createdAt: new Date("2024-01-15") },
  { id: "2", name: "С Новым Годом", text: "С Новым Годом!", fontFamily: "Caveat", color: "#38bdf8", createdAt: new Date("2024-01-10") },
  { id: "3", name: "Спасибо", text: "Большое спасибо", fontFamily: "Caveat", color: "#f472b6", createdAt: new Date("2024-01-05") },
];

// Загруженные opentype-шрифты (кэш)
const otFontCache: Record<string, opentype.Font> = {};

// URL встроенных шрифтов — только TTF, opentype.js не поддерживает woff2
const BUILTIN_FONT_URLS: Record<string, string> = {
  "Caveat": "https://raw.githubusercontent.com/google/fonts/main/ofl/caveat/Caveat%5Bwght%5D.ttf",
};

// Разбить Path на отдельные сегменты-команды и извлечь координаты точек
function getPathPoints(path: opentype.Path): {x: number; y: number}[] {
  const points: {x: number; y: number}[] = [];
  let curX = 0, curY = 0;
  for (const cmd of path.commands) {
    if (cmd.type === "M") { curX = cmd.x; curY = cmd.y; points.push({x: curX, y: curY}); }
    else if (cmd.type === "L") { curX = cmd.x; curY = cmd.y; points.push({x: curX, y: curY}); }
    else if (cmd.type === "C") {
      // кубическая кривая — сэмплируем точки
      const x0 = curX, y0 = curY;
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const x = mt*mt*mt*x0 + 3*mt*mt*t*cmd.x1 + 3*mt*t*t*cmd.x2 + t*t*t*cmd.x;
        const y = mt*mt*mt*y0 + 3*mt*mt*t*cmd.y1 + 3*mt*t*t*cmd.y2 + t*t*t*cmd.y;
        points.push({x, y});
      }
      curX = cmd.x; curY = cmd.y;
    }
    else if (cmd.type === "Q") {
      const x0 = curX, y0 = curY;
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        const x = mt*mt*x0 + 2*mt*t*cmd.x1 + t*t*cmd.x;
        const y = mt*mt*y0 + 2*mt*t*cmd.y1 + t*t*cmd.y;
        points.push({x, y});
      }
      curX = cmd.x; curY = cmd.y;
    }
  }
  return points;
}

// Рисуем текст через opentype по прогрессу [0..1]
function drawHandwriting(
  ctx: CanvasRenderingContext2D,
  font: opentype.Font,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  progress: number,
  color: string,
  lineWidth: number
) {
  const scale = fontSize / font.unitsPerEm;
  const baseline = y - (font.descender * scale);

  // Собираем все точки по всем глифам
  type Segment = { points: {x: number; y: number}[]; penUp: boolean };
  const allSegments: Segment[] = [];

  let cursorX = x;
  for (let i = 0; i < text.length; i++) {
    const glyph = font.charToGlyph(text[i]);
    const path = glyph.getPath(cursorX, baseline, fontSize);

    let segPoints: {x: number; y: number}[] = [];
    let penUp = true;

    for (const cmd of path.commands) {
      if (cmd.type === "M") {
        if (segPoints.length > 0) allSegments.push({ points: segPoints, penUp });
        segPoints = [{x: cmd.x, y: cmd.y}];
        penUp = true;
      } else if (cmd.type === "Z") {
        if (segPoints.length > 0) { allSegments.push({ points: segPoints, penUp: false }); segPoints = []; penUp = true; }
      } else if (cmd.type === "L") {
        segPoints.push({x: cmd.x, y: cmd.y}); penUp = false;
      } else if (cmd.type === "C") {
        const x0 = segPoints[segPoints.length-1]?.x ?? cmd.x;
        const y0 = segPoints[segPoints.length-1]?.y ?? cmd.y;
        for (let s = 1; s <= 14; s++) {
          const t = s / 14; const mt = 1 - t;
          segPoints.push({
            x: mt*mt*mt*x0 + 3*mt*mt*t*cmd.x1 + 3*mt*t*t*cmd.x2 + t*t*t*cmd.x,
            y: mt*mt*mt*y0 + 3*mt*mt*t*cmd.y1 + 3*mt*t*t*cmd.y2 + t*t*t*cmd.y,
          });
        }
        penUp = false;
      } else if (cmd.type === "Q") {
        const x0 = segPoints[segPoints.length-1]?.x ?? cmd.x;
        const y0 = segPoints[segPoints.length-1]?.y ?? cmd.y;
        for (let s = 1; s <= 10; s++) {
          const t = s / 10; const mt = 1 - t;
          segPoints.push({
            x: mt*mt*x0 + 2*mt*t*cmd.x1 + t*t*cmd.x,
            y: mt*mt*y0 + 2*mt*t*cmd.y1 + t*t*cmd.y,
          });
        }
        penUp = false;
      }
    }
    if (segPoints.length > 0) allSegments.push({ points: segPoints, penUp });

    const adv = glyph.advanceWidth ?? 0;
    cursorX += adv * scale;
  }

  // Считаем общее число точек
  const totalPoints = allSegments.reduce((s, seg) => s + seg.points.length, 0);
  const drawPoints = Math.floor(totalPoints * progress);

  // Рисуем
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;

  let drawn = 0;
  outer: for (const seg of allSegments) {
    if (drawn >= drawPoints) break;
    ctx.beginPath();
    for (let pi = 0; pi < seg.points.length; pi++) {
      if (drawn >= drawPoints) {
        ctx.stroke();
        break outer;
      }
      const p = seg.points[pi];
      if (pi === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
      drawn++;
    }
    ctx.stroke();
  }

  // При полном прогрессе — заливаем тоже
  if (progress >= 1) {
    ctx.shadowBlur = 14;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.92;
    const fullPath = font.getPath(text, x, baseline, fontSize);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fullPath.draw(ctx as any);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

export default function Index() {
  const [activeTab, setActiveTab] = useState<Tab>("editor");
  const [text, setText] = useState("Привет, мир!");
  const [fontSize, setFontSize] = useState(64);
  const [speed, setSpeed] = useState(50);
  const [strokeColor, setStrokeColor] = useState("#a855f7");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [bgColor, setBgColor] = useState("#0d0f1a");
  const [isAnimating, setIsAnimating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [projects, setProjects] = useState<Project[]>(SAMPLE_PROJECTS);
  const [uploadedFontName, setUploadedFontName] = useState<string | null>(null);
  const [uploadedFontUrl, setUploadedFontUrl] = useState<string | null>(null);
  const [selectedFont, setSelectedFont] = useState("Caveat");
  const [fontLoading, setFontLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const fontFileRef = useRef<HTMLInputElement>(null);
  const otFontRef = useRef<opentype.Font | null>(null);

  const fontOptions = [
    { label: "Caveat (рукопись)", value: "Caveat" },
    ...(uploadedFontName ? [{ label: `${uploadedFontName} (загружен)`, value: uploadedFontName }] : []),
  ];

  // Загрузить opentype-шрифт
  const loadOtFont = useCallback(async (fontName: string, url?: string) => {
    const cacheKey = url ?? fontName;
    if (otFontCache[cacheKey]) { otFontRef.current = otFontCache[cacheKey]; return; }
    const fontUrl = url ?? BUILTIN_FONT_URLS[fontName];
    if (!fontUrl) return;
    setFontLoading(true);
    try {
      const response = await fetch(fontUrl);
      if (!response.ok) throw new Error(`Font fetch failed: ${response.status} ${fontUrl}`);
      const buffer = await response.arrayBuffer();
      const font = opentype.parse(buffer);
      otFontCache[cacheKey] = font;
      otFontRef.current = font;
    } catch (e) {
      console.error("Font load error:", e);
    } finally {
      setFontLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOtFont(selectedFont, selectedFont === uploadedFontName ? (uploadedFontUrl ?? undefined) : undefined);
  }, [selectedFont, uploadedFontName, uploadedFontUrl, loadOtFont]);

  const drawFrame = useCallback((p: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    if (!otFontRef.current || !text) return;

    // Центрируем по X
    const scale = fontSize / otFontRef.current.unitsPerEm;
    const textWidth = otFontRef.current.getAdvanceWidth(text, fontSize);
    const startX = Math.max(32, (W - textWidth) / 2);

    drawHandwriting(ctx, otFontRef.current, text, startX, H / 2 + (otFontRef.current.ascender * scale) / 2, fontSize, p, strokeColor, strokeWidth);
  }, [text, fontSize, strokeColor, strokeWidth, bgColor]);

  useEffect(() => {
    if (activeTab === "preview") {
      setTimeout(() => drawFrame(1), 80);
    }
  }, [activeTab, drawFrame]);

  const startAnimation = () => {
    if (isAnimating) {
      cancelAnimationFrame(animationRef.current);
      setIsAnimating(false);
      drawFrame(1);
      return;
    }
    setIsAnimating(true);
    setProgress(0);
    drawFrame(0);
    const duration = (100 - speed) * 60 + 800;
    const startTime = performance.now();

    const animate = (now: number) => {
      const p = Math.min((now - startTime) / duration, 1);
      setProgress(p * 100);
      drawFrame(p);
      if (p < 1) { animationRef.current = requestAnimationFrame(animate); }
      else { setIsAnimating(false); }
    };
    animationRef.current = requestAnimationFrame(animate);
  };

  const handleFontUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.[^/.]+$/, "");
    const url = URL.createObjectURL(file);
    // Для CSS
    const fontFace = new FontFace(name, `url(${url})`);
    fontFace.load().then((loaded) => { document.fonts.add(loaded); });
    setUploadedFontName(name);
    setUploadedFontUrl(url);
    setSelectedFont(name);
    loadOtFont(name, url);
  };

  const saveProject = () => {
    const newProject: Project = {
      id: Date.now().toString(),
      name: text.slice(0, 20) || "Новый проект",
      text, fontFamily: selectedFont, color: strokeColor, createdAt: new Date(),
    };
    setProjects((prev) => [newProject, ...prev]);
    setActiveTab("gallery");
  };

  const loadProject = (project: Project) => {
    setText(project.text);
    setSelectedFont(project.fontFamily);
    setStrokeColor(project.color);
    setActiveTab("editor");
  };

  const exportImage = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawFrame(1);
    setTimeout(() => {
      const link = document.createElement("a");
      link.download = `${text.slice(0, 20) || "animation"}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    }, 150);
  };

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "editor", label: "Редактор", icon: "PenTool" },
    { id: "preview", label: "Анимация", icon: "Play" },
    { id: "gallery", label: "Галерея", icon: "LayoutGrid" },
  ];

  return (
    <div className="min-h-screen bg-mesh font-golos text-foreground overflow-x-hidden">
      <header className="fixed top-0 left-0 right-0 z-50 glass border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center animate-pulse-glow">
              <Icon name="Feather" size={16} className="text-white" />
            </div>
            <span className="font-unbounded font-semibold text-sm tracking-wider shimmer-text">ШРИФТОАНИМАТОР</span>
          </div>
          <nav className="flex items-center gap-1 glass rounded-xl p-1">
            {tabs.map((tab) => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-300 ${activeTab === tab.id ? "bg-purple-600 text-white shadow-lg" : "text-muted-foreground hover:text-foreground hover:bg-white/5"}`}>
                <Icon name={tab.icon} size={15} />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            ))}
          </nav>
          <button onClick={saveProject} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-blue-600 text-white text-sm font-medium hover:opacity-90 transition-opacity glow-purple">
            <Icon name="Save" size={15} />
            <span className="hidden sm:inline">Сохранить</span>
          </button>
        </div>
      </header>

      <main className="pt-20 pb-10 max-w-7xl mx-auto px-4">

        {/* EDITOR */}
        {activeTab === "editor" && (
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mt-6 animate-fade-in">
            <div className="lg:col-span-3 space-y-4">
              <div className="gradient-border rounded-2xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-unbounded text-xs font-semibold tracking-widest text-purple-400 uppercase">Текст</h2>
                  <span className="text-xs text-muted-foreground">{text.length} символов</span>
                </div>
                <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Введите текст..."
                  className="w-full h-28 bg-transparent border-none outline-none resize-none text-foreground placeholder:text-muted-foreground/40 text-lg leading-relaxed"
                  style={{ fontFamily: selectedFont, fontSize: `${Math.min(fontSize, 28)}px` }} />
              </div>
              <div className="gradient-border rounded-2xl min-h-[180px] flex items-center justify-center p-8 overflow-hidden" style={{ backgroundColor: bgColor }}>
                <p className="text-center select-none transition-all duration-300 break-all"
                  style={{ fontFamily: selectedFont, fontSize: `clamp(24px, ${fontSize * 0.5}px, 72px)`, color: strokeColor, textShadow: `0 0 20px ${strokeColor}88, 0 0 40px ${strokeColor}44`, lineHeight: 1.2 }}>
                  {text || "Ваш текст здесь"}
                </p>
              </div>
            </div>

            <div className="lg:col-span-2 space-y-4">
              <div className="glass rounded-2xl p-5 glass-hover">
                <h3 className="font-unbounded text-xs tracking-widest text-blue-400 uppercase mb-4">Шрифт</h3>
                <select value={selectedFont} onChange={(e) => setSelectedFont(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-foreground outline-none focus:border-purple-500 transition-colors mb-3">
                  {fontOptions.map((f) => (
                    <option key={f.value} value={f.value} className="bg-[#0d0f1a]">{f.label}</option>
                  ))}
                </select>
                <button onClick={() => fontFileRef.current?.click()}
                  className="w-full py-3 rounded-xl border border-dashed border-white/20 text-sm text-muted-foreground hover:border-purple-500 hover:text-purple-400 transition-all flex items-center justify-center gap-2">
                  <Icon name="Upload" size={15} />
                  {uploadedFontName ? `Загружен: ${uploadedFontName}` : "Загрузить свой шрифт (.ttf, .otf)"}
                </button>
                <input ref={fontFileRef} type="file" accept=".ttf,.otf,.woff,.woff2" className="hidden" onChange={handleFontUpload} />
              </div>

              <div className="glass rounded-2xl p-5 glass-hover space-y-5">
                <h3 className="font-unbounded text-xs tracking-widest text-pink-400 uppercase">Параметры</h3>
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Размер шрифта</span>
                    <span className="text-sm font-medium text-purple-400">{fontSize}px</span>
                  </div>
                  <input type="range" min={16} max={200} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} className="w-full" />
                </div>
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Скорость анимации</span>
                    <span className="text-sm font-medium text-purple-400">{speed}%</span>
                  </div>
                  <input type="range" min={1} max={99} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full" />
                </div>
                <div>
                  <div className="flex justify-between mb-2">
                    <span className="text-sm text-muted-foreground">Толщина пера</span>
                    <span className="text-sm font-medium text-purple-400">{strokeWidth}px</span>
                  </div>
                  <input type="range" min={1} max={10} value={strokeWidth} onChange={(e) => setStrokeWidth(Number(e.target.value))} className="w-full" />
                </div>
                <div className="flex gap-4">
                  <div className="flex-1">
                    <span className="text-sm text-muted-foreground block mb-2">Цвет текста</span>
                    <div className="relative h-12 rounded-xl overflow-hidden border border-white/10">
                      <input type="color" value={strokeColor} onChange={(e) => setStrokeColor(e.target.value)} className="absolute inset-0 w-full h-full cursor-pointer opacity-0 z-10" />
                      <div className="absolute inset-0 flex items-center justify-center gap-2" style={{ backgroundColor: strokeColor + "33" }}>
                        <div className="w-5 h-5 rounded-full border-2 border-white/30" style={{ backgroundColor: strokeColor }} />
                        <span className="text-xs font-mono text-foreground">{strokeColor}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex-1">
                    <span className="text-sm text-muted-foreground block mb-2">Фон</span>
                    <div className="relative h-12 rounded-xl overflow-hidden border border-white/10">
                      <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="absolute inset-0 w-full h-full cursor-pointer opacity-0 z-10" />
                      <div className="absolute inset-0 flex items-center justify-center gap-2" style={{ backgroundColor: bgColor }}>
                        <div className="w-5 h-5 rounded-full border-2 border-white/30" style={{ backgroundColor: bgColor }} />
                        <span className="text-xs font-mono" style={{ color: "#aaa" }}>{bgColor}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <button onClick={() => setActiveTab("preview")}
                  className="flex-1 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-blue-600 text-white text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity glow-purple">
                  <Icon name="Play" size={16} />Запустить
                </button>
                <button onClick={exportImage}
                  className="flex-1 py-3 rounded-xl glass border border-white/10 text-foreground text-sm font-medium flex items-center justify-center gap-2 hover:border-purple-500 transition-colors">
                  <Icon name="Download" size={16} />Экспорт PNG
                </button>
              </div>
            </div>
          </div>
        )}

        {/* PREVIEW */}
        {activeTab === "preview" && (
          <div className="space-y-6 mt-6 animate-fade-in">
            <div className="text-center space-y-2">
              <h2 className="font-unbounded font-semibold text-xl shimmer-text">Анимация письма</h2>
              <p className="text-muted-foreground text-sm">
                {fontLoading ? "Загрузка шрифта..." : "Нажмите «Воспроизвести» чтобы увидеть эффект рукописного письма"}
              </p>
            </div>

            <div className="gradient-border rounded-2xl overflow-hidden mx-auto max-w-3xl">
              <canvas ref={canvasRef} width={800} height={400} className="w-full block" />
            </div>

            <div className="max-w-3xl mx-auto">
              <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-75"
                  style={{ width: `${progress}%`, background: `linear-gradient(90deg, ${strokeColor}, #38bdf8)`, boxShadow: `0 0 10px ${strokeColor}88` }} />
              </div>
            </div>

            <div className="flex items-center justify-center gap-4">
              <button onClick={() => { setProgress(0); drawFrame(0); }}
                className="w-12 h-12 rounded-full glass border border-white/10 flex items-center justify-center hover:border-white/30 transition-colors">
                <Icon name="SkipBack" size={18} />
              </button>
              <button onClick={startAnimation} disabled={fontLoading}
                className={`w-16 h-16 rounded-full flex items-center justify-center text-white transition-all disabled:opacity-50 ${isAnimating ? "bg-red-600 hover:bg-red-700" : "bg-gradient-to-br from-purple-600 to-blue-600 hover:opacity-90 glow-purple"}`}>
                {fontLoading ? <Icon name="Loader" size={22} className="animate-spin" /> : <Icon name={isAnimating ? "Square" : "Play"} size={22} />}
              </button>
              <button onClick={exportImage}
                className="w-12 h-12 rounded-full glass border border-white/10 flex items-center justify-center hover:border-purple-400 hover:text-purple-400 transition-colors">
                <Icon name="Download" size={18} />
              </button>
            </div>

            <div className="max-w-3xl mx-auto glass rounded-2xl p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-2 text-center">Скорость</p>
                <input type="range" min={1} max={99} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full" />
                <p className="text-xs text-purple-400 mt-1 text-center font-medium">{speed}%</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-2 text-center">Размер</p>
                <input type="range" min={16} max={200} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} className="w-full" />
                <p className="text-xs text-purple-400 mt-1 text-center font-medium">{fontSize}px</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground mb-2">Цвет текста</p>
                <div className="relative h-9 rounded-xl overflow-hidden border border-white/10 mx-2">
                  <input type="color" value={strokeColor} onChange={(e) => setStrokeColor(e.target.value)} className="absolute inset-0 w-full h-full cursor-pointer opacity-0" />
                  <div className="absolute inset-0 rounded-xl flex items-center justify-center" style={{ backgroundColor: strokeColor + "44" }}>
                    <div className="w-5 h-5 rounded-full" style={{ backgroundColor: strokeColor }} />
                  </div>
                </div>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground mb-2">Фон</p>
                <div className="relative h-9 rounded-xl overflow-hidden border border-white/10 mx-2">
                  <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="absolute inset-0 w-full h-full cursor-pointer opacity-0" />
                  <div className="absolute inset-0 rounded-xl" style={{ backgroundColor: bgColor }} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* GALLERY */}
        {activeTab === "gallery" && (
          <div className="space-y-6 mt-6 animate-fade-in">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-unbounded font-semibold text-xl shimmer-text">Галерея проектов</h2>
                <p className="text-muted-foreground text-sm mt-1">{projects.length} сохранённых проектов</p>
              </div>
              <button onClick={() => setActiveTab("editor")}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-blue-600 text-white text-sm font-medium hover:opacity-90 transition-opacity glow-purple">
                <Icon name="Plus" size={16} />Новый проект
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {projects.map((project, index) => (
                <div key={project.id} className="glass rounded-2xl overflow-hidden glass-hover cursor-pointer group"
                  style={{ animationDelay: `${index * 0.1}s` }} onClick={() => loadProject(project)}>
                  <div className="h-36 flex items-center justify-center relative overflow-hidden" style={{ backgroundColor: "#0d0f1a" }}>
                    <div className="absolute inset-0 opacity-20" style={{ background: `radial-gradient(circle at 50% 50%, ${project.color}, transparent 70%)` }} />
                    <p className="text-center px-4 z-10 text-3xl select-none"
                      style={{ color: project.color, textShadow: `0 0 20px ${project.color}88`, fontFamily: project.fontFamily }}>
                      {project.text}
                    </p>
                  </div>
                  <div className="p-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm text-foreground">{project.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{project.fontFamily} · {project.createdAt.toLocaleDateString("ru")}</p>
                    </div>
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={(e) => { e.stopPropagation(); loadProject(project); setActiveTab("preview"); }}
                        className="w-8 h-8 rounded-lg bg-purple-600/20 border border-purple-500/30 flex items-center justify-center hover:bg-purple-600/40 transition-colors text-purple-400">
                        <Icon name="Play" size={14} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setProjects((prev) => prev.filter((p) => p.id !== project.id)); }}
                        className="w-8 h-8 rounded-lg bg-red-600/20 border border-red-500/30 flex items-center justify-center hover:bg-red-600/40 transition-colors text-red-400">
                        <Icon name="Trash2" size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {projects.length === 0 && (
                <div className="col-span-full flex flex-col items-center justify-center py-20 text-center">
                  <div className="w-16 h-16 rounded-2xl glass flex items-center justify-center mb-4 animate-float">
                    <Icon name="Feather" size={28} className="text-purple-400" />
                  </div>
                  <h3 className="font-semibold text-lg mb-2">Пока пусто</h3>
                  <p className="text-muted-foreground text-sm mb-6">Создайте первый проект в редакторе</p>
                  <button onClick={() => setActiveTab("editor")}
                    className="px-6 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-blue-600 text-white text-sm font-medium hover:opacity-90 transition-opacity">
                    Открыть редактор
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}