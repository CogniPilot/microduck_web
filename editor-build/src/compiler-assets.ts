export function compilerAsset(base:string|URL,kind:"js"|"wasm"){return new URL(`vendor/rumoca-6fd79278-release/rumoca_bind_wasm${kind==="wasm"?"_bg.wasm":".js"}`,base).href;}
