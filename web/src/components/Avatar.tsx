// Initials on a gradient picked from the username, like Orchard's account avatars.
const HUES = [[12, 350], [28, 8], [200, 250], [150, 190], [270, 320], [40, 15], [330, 290], [175, 215]];

export default function Avatar({ name, username, size = 32 }: { name?: string; username: string; size?: number }) {
  const label = (name || username).trim();
  const initials = label.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  let h = 0;
  for (const c of username) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = HUES[h % HUES.length];
  return (
    <span
      className="avatar"
      aria-hidden
      style={{
        width: size, height: size, fontSize: Math.round(size * 0.38),
        background: `radial-gradient(circle at 30% 25%, hsl(${a} 95% 72%), transparent 65%), linear-gradient(135deg, hsl(${a} 80% 55%), hsl(${b} 70% 42%))`,
      }}
    >
      {initials}
    </span>
  );
}
