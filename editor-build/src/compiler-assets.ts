export function compilerAsset(base:string|URL,kind:"js"|"wasm"){return new URL(`vendor/rumoca-4f0a575d/rumoca_bind_wasm${kind==="wasm"?"_bg.wasm":".js"}`,base).href;}
