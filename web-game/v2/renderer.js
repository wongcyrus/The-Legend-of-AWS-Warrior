export class WebGLUnavailableError extends Error {
  constructor() {
    super("This browser could not start WebGL graphics.");
    this.name = "WebGLUnavailableError";
  }
}

export function createRenderer(Renderer, createCanvas = () => document.createElement("canvas")) {
  for (const name of ["webgl2", "webgl", "experimental-webgl"]) {
    for (const antialias of [true, false]) {
      const canvas = createCanvas();
      const attributes = {
        alpha: false,
        depth: true,
        stencil: true,
        antialias,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference: "default",
        failIfMajorPerformanceCaveat: false,
      };
      let context;
      try {
        context = canvas.getContext(name, attributes);
        if (!context) continue;
        if (name !== "webgl2" && !context.getExtension("ANGLE_instanced_arrays")) {
          context.getExtension("WEBGL_lose_context")?.loseContext();
          continue;
        }
        const renderer = new Renderer({ canvas, context, ...attributes });
        return { renderer, compatibilityMode: name !== "webgl2" || !antialias };
      } catch {
        context?.getExtension("WEBGL_lose_context")?.loseContext();
      }
    }
  }
  throw new WebGLUnavailableError();
}
