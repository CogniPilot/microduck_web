export function compilerAsset(base:string|URL,kind:"js"|"wasm"){return new URL(`vendor/rumoca-8583646a-release/rumoca_bind_wasm${kind==="wasm"?"_bg.wasm":".js"}`,base).href;}
