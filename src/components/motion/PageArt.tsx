import Wireframe from "./Wireframe";

/** A slowly turning line-art object in the corner of a page header. Drag to spin it. Decorative. */
export default function PageArt({ shape }: { shape: "globe" | "torus" | "cube" | "helix" }) {
  return <div className="page-art" aria-hidden="true"><Wireframe shape={shape} nodes={shape === "globe" ? 18 : 0} speed={0.8} /></div>;
}
