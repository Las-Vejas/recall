/** Slowly drifting colour blobs behind the home banner and sign-in pages (Orchard-style mesh gradient).
 *  Colours come from the theme (index.css, .mesh); the motion is transform-only, so it stays smooth and cheap. */
export default function Mesh() {
  return (
    <div className="mesh" aria-hidden="true">
      <i /><i /><i /><i />
    </div>
  );
}
