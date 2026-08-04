interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  rotation: number;
  rotationSpeed: number;
  life: number;
}

const COLORS = ['#FFD700', '#FF69B4', '#8B5CF6', '#3B82F6', '#22C55E', '#EF4444'];

export function launchConfetti(duration = 3000): () => void {
  const canvas = document.createElement('canvas');
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '9999';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particleCount = 100 + Math.floor(Math.random() * 50);
  const particles: Particle[] = [];

  for (let i = 0; i < particleCount; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height * -0.5,
      vx: (Math.random() - 0.5) * 8,
      vy: Math.random() * 3 + 2,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      size: Math.random() * 6 + 4,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 10,
      life: 1,
    });
  }

  let animationId: number;
  let removed = false;

  function animate() {
    if (removed) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let alive = false;
    for (const p of particles) {
      if (p.life <= 0) continue;
      alive = true;

      p.x += p.vx;
      p.vy += 0.15; // gravity
      p.y += p.vy;
      p.rotation += p.rotationSpeed;
      p.life -= 0.003;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }

    if (alive) {
      animationId = requestAnimationFrame(animate);
    } else {
      cleanup();
    }
  }

  function cleanup() {
    if (removed) return;
    removed = true;
    cancelAnimationFrame(animationId);
    canvas.remove();
  }

  animationId = requestAnimationFrame(animate);
  const timer = setTimeout(cleanup, duration);

  return () => {
    clearTimeout(timer);
    cleanup();
  };
}
