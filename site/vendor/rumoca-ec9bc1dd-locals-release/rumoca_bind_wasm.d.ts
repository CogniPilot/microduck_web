/* tslint:disable */
/* eslint-disable */

/**
 * Checked artifacts owned by this WASM instance; call `free()` when replaced.
 * No global handle registry or cross-worker object transfer is needed.
 */
export class WasmCompiledModel {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Original-system metrics, independently of reduced solver coordinates.
     */
    analysis_json(): string;
    /**
     * Existing compile payload, only when its DAE was requested.
     */
    compile_response_json(): string;
    /**
     * Render from retained artifacts, without compilation or lowering.
     */
    render_target(target: string, manifest_source: string, templates_json: string): string;
    /**
     * Exact canonical JSON, exposed only for requested representations.
     */
    representation_json(representation: string): string;
    /**
     * Lowering failure does not discard the original compiled DAE.
     */
    solve_error(): string | undefined;
}

/**
 * Opaque handle to a real-time simulation session running in WASM.
 *
 * Compiles a Modelica model and creates an interactive session that can be
 * driven from JavaScript via `requestAnimationFrame`.
 */
export class WasmSimulationSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Advance the simulation to an absolute target time in seconds.
     */
    advance_to(target_time: number): void;
    /**
     * Release idle prepared resources. Active sessions remain exclusive and
     * cannot repopulate this cache when they are later freed.
     */
    static clearPreparationCache(): void;
    /**
     * The execution engine the session selected, as the JSON receipt
     * `{"engine": "interpreter" | "cranelift" | "wasm_program", "refusal":
     * null | "no_continuous_states" | "external_tables"}`. It is the engine
     * field of the protocol `hello` event.
     */
    execution_receipt_json(): string;
    /**
     * Load a current-build artifact without compiling its Modelica sources.
     * The explicit source set must match the export exactly; options are
     * checked and applied by the same owner as source-created sessions.
     */
    static fromPrebuiltArtifact(artifact_json: string, source: string, model_name: string, workspace_sources_json: string, options_json: string): WasmSimulationSession;
    /**
     * Load a complete current-build runtime/core-kernel product. Source,
     * compiler and all options are checked before replay or instantiation.
     */
    static fromPrecompiledRuntimeArtifact(artifact: Uint8Array, source: string, model_name: string, workspace_sources_json: string, options_json: string): WasmSimulationSession;
    /**
     * Read a single variable value by name.
     */
    get(name: string): number | undefined;
    /**
     * Get available input names as a JSON array string.
     */
    input_names(): string;
    /**
     * Compile a Modelica model and create a session ready for interactive use.
     *
     * `source` is the full Modelica source text and `model_name` is the class
     * to simulate. The model's experiment metadata supplies default simulation
     * options.
     */
    constructor(source: string, model_name: string);
    /**
     * Whether this creation reused a released prepared session and performed
     * the original-default reset instead of rebuilding its runtime.
     */
    preparation_reused(): boolean;
    /**
     * Read named values in request order as a JavaScript `Float64Array`.
     *
     * `names_json` is a JSON array of variable/input names. Duplicates are
     * preserved. An unknown name rejects the entire read; no value is filled
     * in. This uses one ordinary session observation and does not advance time.
     */
    read_values(names_json: string): Float64Array;
    /**
     * Reset the simulation to initial conditions.
     */
    reset(): void;
    /**
     * Restart the original Modelica initialization at an absolute time.
     * Invalid restart coordinates leave the existing session untouched.
     */
    reset_at(time: number): void;
    /**
     * Set an input value by name. Takes effect on the next advance.
     */
    set_input(name: string, value: number): void;
    /**
     * Apply one atomic input frame encoded as `[["name", value], ...]`.
     */
    set_inputs(inputs_json: string): void;
    /**
     * Get all current variable values as a JSON string `{"time": t, "values": {...}}`.
     */
    state_json(): string;
    /**
     * Advance the simulation by a relative time step in seconds.
     */
    step(dt: number): void;
    /**
     * Get the current simulation time.
     */
    time(): number;
    /**
     * Get all solver variable names as a JSON array string.
     */
    variable_names(): string;
    /**
     * Construct an interactive session with checked options including the
     * `native_required`, `auto`, or `interpreter` execution policy. Empty
     * options retain the model's experiment metadata and require compilation.
     */
    static withInteractiveConfiguration(source: string, model_name: string, options_json: string): WasmSimulationSession;
    /**
     * Compile a Modelica model and create a user-terminated interactive session.
     */
    static withInteractiveOptions(source: string, model_name: string, dt: number, solver: string, atol: number, rtol: number, initial_inputs_json: string): WasmSimulationSession;
}

/**
 * Enable/reset diagnostic clocks in an explicitly instrumented build.
 */
export function browser_profile_enable(enabled: boolean): void;

/**
 * Inclusive/exclusive wall clocks; per-call instrumentation adds overhead.
 */
export function browser_profile_snapshot(): string;

/**
 * Check Modelica source code and return all diagnostics.
 */
export function check(source: string): any;

export function clear_source_root_cache(): void;

/**
 * Compile Modelica source code to DAE JSON.
 */
export function compile(source: string, model_name: string): string;

export function compile_check_with_source_roots(source: string, model_name: string, source_roots_json: string): string;

/**
 * Compile Modelica source code to DAE JSON (alias for worker compatibility).
 */
export function compile_to_json(source: string, model_name: string): string;

/**
 * Options use the current schema: `{"representations":["dae","solve"]}`.
 */
export function compile_with_options(source: string, model_name: string, options_json: string): WasmCompiledModel;

export function compile_with_source_roots(source: string, model_name: string, source_roots_json: string): string;

export function compile_with_workspace_sources(source: string, model_name: string, workspace_sources_json: string): string;

export function export_parsed_source_roots_binary(uris_json: string): Uint8Array;

/**
 * Compile the explicit complete source set in an isolated session and export
 * a DAE plus experiment defaults. It skips source compilation on later load;
 * Solve lowering, kernel generation and runtime initialization still run.
 * Artifacts are trusted build outputs, not signatures or an authenticity proof.
 */
export function export_prebuilt_artifact(source: string, model_name: string, workspace_sources_json: string): string;

/**
 * Build-time export. This executes the common preparation once and records
 * the original emitted kernels; the page later loads them without emission.
 * These are trusted build outputs, not signatures or an authenticity proof.
 */
export function export_precompiled_runtime_artifact(source: string, model: string, sources: string, options_json: string): Uint8Array;

/**
 * Get the UTC build timestamp for this WASM build.
 */
export function get_build_time_utc(): string;

/**
 * Get the built-in codegen targets this WASM build can render.
 */
export function get_builtin_targets(): any;

export function get_bundled_source_root_manifest(): string;

/**
 * Get detailed class documentation and summary metadata.
 */
export function get_class_info(qualified_name: string): string;

/**
 * Get the Git commit this WASM build was compiled from, with a `-dirty`
 * marker for a modified tree; `undefined` when the build could not determine
 * it. A pull-request build reports the synthetic merge commit it compiled;
 * `compiler_provenance` also names the merged parents.
 */
export function get_git_commit(): string | undefined;

/**
 * Discover compilable simulation models in a source document.
 */
export function get_simulation_models(source: string, default_model: string): string;

export function get_source_root_document_count(): number;

export function get_source_root_statuses(): string;

/**
 * Get the Rumoca version string.
 */
export function get_version(): string;

/**
 * Initialize panic hook for better error messages in console.
 */
export function init(): void;

/**
 * Lint Modelica source code and return messages.
 */
export function lint(source: string): any;

/**
 * List all loaded classes as a package/class hierarchy.
 */
export function list_classes(): string;

export function load_bundled_source_root_cache(archive_id: string): number;

export function load_source_roots(source_roots_json: string): string;

/**
 * Compile a model and return its lowered `SolveModel` as JSON, for the lazy
 * diffsol addon (`@cognipilot/rumoca/diffsol`) to simulate. Lets the stiff
 * solver run without putting relaxed-SIMD in this (universal) module.
 */
export function lower_model_to_solve_json(source: string, model_name: string, t_end: number, dt: number, parameter_overrides_json: string): string;

/**
 * Get code actions (quick fixes) for diagnostics in a selected range.
 */
export function lsp_code_actions(source: string, range_start_line: number, range_start_character: number, range_end_line: number, range_end_character: number, diagnostics_json: string): string;

/**
 * Get code completion suggestions.
 */
export function lsp_completion(source: string, line: number, character: number): string;

/**
 * Get code completion suggestions plus the completion timing breakdown used by the benchmark.
 */
export function lsp_completion_with_timing(source: string, line: number, character: number): string;

/**
 * Get go-to-definition target(s) for a position.
 */
export function lsp_definition(source: string, line: number, character: number): string;

/**
 * Compute diagnostics (syntax, lint, and compilation errors).
 */
export function lsp_diagnostics(source: string): string;

/**
 * Get document symbols (outline).
 */
export function lsp_document_symbols(source: string): string;

/**
 * Get hover information for a position.
 */
export function lsp_hover(source: string, line: number, character: number): string;

/**
 * Get the semantic token legend.
 */
export function lsp_semantic_token_legend(): string;

/**
 * Get semantic tokens for syntax highlighting.
 */
export function lsp_semantic_tokens(source: string): string;

export function merge_parsed_source_roots(definitions_json: string): number;

export function merge_parsed_source_roots_binary(bytes: Uint8Array): number;

/**
 * Compile a model and return tunable scalar parameter metadata as JSON.
 */
export function model_parameter_metadata(source: string, model_name: string): string;

/**
 * Compile with additional source-root libraries and return parameter metadata.
 */
export function model_parameter_metadata_with_source_roots(source: string, model_name: string, source_roots_json: string): string;

/**
 * Compile with additional workspace-local sources and return parameter metadata.
 */
export function model_parameter_metadata_with_workspace_sources(source: string, model_name: string, workspace_sources_json: string): string;

/**
 * Parse Modelica source code and return whether it's valid.
 */
export function parse(source: string): any;

export function parse_source_root_file(source: string, filename: string): string;

/**
 * Deterministic key for the exact source set, selected class and this compiler.
 * Companion keys are canonical relative paths; `input.mo` is reserved for source.
 * Retain the returned string alongside the opaque artifact at site build time.
 */
export function prebuilt_artifact_key(source: string, model_name: string, workspace_sources_json: string): string;

/**
 * Identity of the exact compiler/model/source set and checked runtime options.
 */
export function precompiled_runtime_key(source: string, model: string, sources: string, options_json: string): string;

/**
 * Prepare a model for WebGPU execution.
 *
 * Compiles `source`, lowers it to the Solve IR with simulation defaults
 * (honoring the model's `experiment` annotation like `simulate_model`),
 * renders the `wgsl-ode` builtin target, and returns a JSON object:
 *
 * ```json
 * {
 *   "wgsl": "...compute shader source...",
 *   "layout": { ...the wgsl-ode layout manifest... },
 *   "y0": [..], "p0": [..],
 *   "n_states": 3,
 *   "t_start": 0.0, "t_end": 1.0,
 *   "dt": 0.1,
 *   "internal_dt": 0.0125
 * }
 * ```
 *
 * This API accepts explicit ODEs only. It settles supported initialization on
 * the CPU before dispatch, then the host integrates the first `n_states`
 * entries of `y`. Algebraic projection, events, clocks, and the other
 * unsupported `wgsl-ode` capabilities fail before a shader is rendered.
 */
export function prepare_gpu_simulation(source: string, model_name: string): string;

/**
 * Compile a stateless native-family assignment pipeline to portable CPU WASM.
 * Hosts write input P slots before each invocation, execute stages in the issued
 * order, and copy each complete stage output into its exact target Y range.
 * No equation solving, kernel isolation, or schedule discovery occurs in a host.
 */
export function prepare_native_assignments(source: string, model_name: string): string;

/**
 * Compile one stateless assignment module with shared Y/P storage.
 * The host writes P and calls `eval_assignments` once. Integer and Boolean
 * inputs are written to the typed input lanes listed in `input_lanes` (i64,
 * u8) at the start of the typed lane buffer, never to P. Derived discrete
 * outputs (Integer, Boolean, discrete Real) are published through the typed
 * output lanes listed in `derived_outputs`, after the input lanes; read
 * Integer lanes with [`read_native_integer_lane`] or a `BigInt64Array`.
 * All source-issued stage ordering and direct target writes live in the module.
 */
export function prepare_native_program(source: string, model_name: string): string;

/**
 * Compile the same program with the model's carried state (SPEC_0040
 * SOLVE-C101). `pairs` is a JSON array of `[output, input]` variable names,
 * the host contract the package declares: the host feeds the Real output to
 * the Real input of the same shape between evaluations. Each output is
 * published into its input instead of into Y, so a host that feeds a step's
 * next state to its next step moves nothing and a value the step returns
 * unchanged is already in place. The artifact lists the runs under
 * `abi.carried`; the host Y cells of a run are not written and P is not
 * read-only.
 */
export function prepare_native_program_carrying(source: string, model_name: string, pairs: string): string;

export function prime_source_root_completion_cache(): number;

/**
 * Read one Integer output lane, the little-endian i64 at `byte_offset` of the
 * published output lanes: a JavaScript number when its value is exactly
 * representable as one, otherwise a BigInt, so no host read rounds it.
 *
 * Coverage exemption: the JavaScript values exist only under a JavaScript
 * host, so no workspace test can call this; the decoding it publishes is
 * [`integer_lane`], which the tests cover.
 */
export function read_native_integer_lane(lanes: Uint8Array, byte_offset: number): any;

/**
 * Render a target from a checked DAE serialized by `compile`. Flat targets
 * need the model source; use [`render_target_for_source`] for those.
 */
export function render_target(dae_json: string, model_name: string, target: string, manifest_source: string, templates_json: string): any;

/**
 * Compile `model_name` from `source` and render a target from the result.
 */
export function render_target_for_source(source: string, model_name: string, target: string, manifest_source: string, templates_json: string): any;

/**
 * Like [`render_target_for_source`], resolving against the given workspace
 * sources (the same map `compile_with_workspace_sources` takes).
 */
export function render_target_with_workspace_sources(source: string, model_name: string, workspace_sources_json: string, target: string, manifest_source: string, templates_json: string): any;

/**
 * Default colocated `rumoca-scenario.<model>.toml` (`{ ok, path, content }`)
 * for a create-config action on a Modelica model.
 */
export function scenario_default_scenario_config(workspace_sources_json: string, model: string, task: string): string;

/**
 * Configured `[codegen]` target settings for a model (`{ target, outputDir }`).
 */
export function scenario_get_codegen_config(workspace_sources_json: string, model: string): string;

/**
 * Parse a single `rumoca-scenario.toml` scenario file (by workspace path) into the editor's
 * scenario descriptor (`task`, `model`, `viewerMode`, interactive ports, ...).
 */
export function scenario_get_scenario_config(workspace_sources_json: string, path: string): string;

/**
 * Full `rumoca-scenario.toml` scenario as a JSON tree for the config GUI:
 * `{ ok, config: <toml-as-json>, descriptor }`. The `config` tree round-trips
 * every section (including nested interactive-IO) losslessly.
 */
export function scenario_get_scenario_config_full(workspace_sources_json: string, path: string): string;

/**
 * Effective + preset + default simulation settings for a model, given the
 * workspace's `rumoca-scenario.toml` files and an optional editor `fallback` settings JSON.
 */
export function scenario_get_simulation_config(workspace_sources_json: string, model: string, fallback_json: string): string;

/**
 * Scenario-local source roots configured for a model (`{ sourceRootPaths }`).
 */
export function scenario_get_source_roots(workspace_sources_json: string, model: string, task: string): string;

/**
 * Configured plot/visualization views for a model (`{ views: [...] }`).
 */
export function scenario_get_visualization_config(workspace_sources_json: string, model: string): string;

/**
 * Clear a model's simulation preset. Returns `{ writes, result }`.
 */
export function scenario_reset_simulation_preset(workspace_sources_json: string, model: string): string;

/**
 * Write a model's `[codegen]` target settings. Returns `{ writes, result }`.
 */
export function scenario_set_codegen_config(workspace_sources_json: string, model: string, codegen_json: string): string;

/**
 * Render a `rumoca-scenario.toml` from the config GUI's JSON tree. Returns
 * `{ writes: [{path, content}], result }` for the editor to apply.
 */
export function scenario_set_scenario_config(path: string, config_json: string): string;

/**
 * Write a model's simulation preset into its colocated `rum.<model>.toml`.
 * Returns `{ writes, result }` for the editor to apply to its workspace store.
 */
export function scenario_set_simulation_preset(workspace_sources_json: string, model: string, preset_json: string): string;

/**
 * Write a model's scenario-local source roots. Returns `{ writes, result }`.
 */
export function scenario_set_source_roots(workspace_sources_json: string, model: string, source_roots_json: string): string;

/**
 * Write a model's plot/visualization views. Returns `{ writes, result }`.
 */
export function scenario_set_visualization_config(workspace_sources_json: string, model: string, views_json: string): string;

/**
 * Compile and simulate a Modelica model.
 */
export function simulate_model(source: string, model_name: string, t_end: number, dt: number, solver: string, parameter_overrides_json: string): string;

/**
 * Compile with additional workspace-local sources and simulate a Modelica model.
 */
export function simulate_model_with_workspace_sources(source: string, model_name: string, workspace_sources_json: string, t_end: number, dt: number, solver: string, parameter_overrides_json: string): string;

export function sync_workspace_sources(workspace_sources_json: string): string;

/**
 * Re-settle prepared vectors for new parameter values. The initial GPU prepare
 * uses lean lowering, so updates perform full runtime lowering on demand.
 * `overrides_json` is a `{ "name": value }` object naming scalar parameters.
 * Returns `{ "y0": [...], "p0": [...] }`.
 */
export function update_gpu_parameters(source: string, model_name: string, overrides_json: string): string;

/**
 * Fallback thread-pool initializer for non-threaded builds.
 */
export function wasm_init(_num_threads: number): boolean;

export function workspace_effective_source_roots(workspace_sources_json: string, focus_path: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly workspace_effective_source_roots: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly __wbg_wasmcompiledmodel_free: (a: number, b: number) => void;
    readonly __wbg_wasmsimulationsession_free: (a: number, b: number) => void;
    readonly compile_with_options: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly prepare_native_assignments: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly prepare_native_program: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly prepare_native_program_carrying: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly read_native_integer_lane: (a: number, b: number, c: number) => [number, number, number];
    readonly wasmcompiledmodel_analysis_json: (a: number) => [number, number, number, number];
    readonly wasmcompiledmodel_compile_response_json: (a: number) => [number, number, number, number];
    readonly wasmcompiledmodel_render_target: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly wasmcompiledmodel_representation_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmcompiledmodel_solve_error: (a: number) => [number, number];
    readonly wasmsimulationsession_advance_to: (a: number, b: number) => [number, number];
    readonly wasmsimulationsession_execution_receipt_json: (a: number) => [number, number, number, number];
    readonly wasmsimulationsession_fromPrebuiltArtifact: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly wasmsimulationsession_fromPrecompiledRuntimeArtifact: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly wasmsimulationsession_get: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmsimulationsession_input_names: (a: number) => [number, number, number, number];
    readonly wasmsimulationsession_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly wasmsimulationsession_preparation_reused: (a: number) => number;
    readonly wasmsimulationsession_read_values: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmsimulationsession_reset: (a: number) => [number, number];
    readonly wasmsimulationsession_reset_at: (a: number, b: number) => [number, number];
    readonly wasmsimulationsession_set_input: (a: number, b: number, c: number, d: number) => [number, number];
    readonly wasmsimulationsession_set_inputs: (a: number, b: number, c: number) => [number, number];
    readonly wasmsimulationsession_state_json: (a: number) => [number, number, number, number];
    readonly wasmsimulationsession_step: (a: number, b: number) => [number, number];
    readonly wasmsimulationsession_time: (a: number) => number;
    readonly wasmsimulationsession_variable_names: (a: number) => [number, number, number, number];
    readonly wasmsimulationsession_withInteractiveConfiguration: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly wasmsimulationsession_withInteractiveOptions: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly wasmsimulationsession_clearPreparationCache: () => void;
    readonly prepare_gpu_simulation: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly update_gpu_parameters: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly browser_profile_enable: (a: number) => void;
    readonly browser_profile_snapshot: () => [number, number];
    readonly check: (a: number, b: number) => [number, number, number];
    readonly clear_source_root_cache: () => [number, number];
    readonly compile: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly compile_check_with_source_roots: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly compile_with_source_roots: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly compile_with_workspace_sources: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly export_parsed_source_roots_binary: (a: number, b: number) => [number, number, number, number];
    readonly export_prebuilt_artifact: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly export_precompiled_runtime_artifact: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly get_build_time_utc: () => [number, number];
    readonly get_builtin_targets: () => [number, number, number];
    readonly get_bundled_source_root_manifest: () => [number, number];
    readonly get_class_info: (a: number, b: number) => [number, number, number, number];
    readonly get_git_commit: () => [number, number];
    readonly get_simulation_models: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly get_source_root_document_count: () => [number, number, number];
    readonly get_source_root_statuses: () => [number, number, number, number];
    readonly get_version: () => [number, number];
    readonly lint: (a: number, b: number) => [number, number, number];
    readonly list_classes: () => [number, number, number, number];
    readonly load_bundled_source_root_cache: (a: number, b: number) => [number, number, number];
    readonly load_source_roots: (a: number, b: number) => [number, number, number, number];
    readonly lower_model_to_solve_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly lsp_code_actions: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly lsp_completion: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly lsp_completion_with_timing: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly lsp_definition: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly lsp_diagnostics: (a: number, b: number) => [number, number, number, number];
    readonly lsp_document_symbols: (a: number, b: number) => [number, number, number, number];
    readonly lsp_hover: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly lsp_semantic_token_legend: () => [number, number, number, number];
    readonly lsp_semantic_tokens: (a: number, b: number) => [number, number, number, number];
    readonly merge_parsed_source_roots: (a: number, b: number) => [number, number, number];
    readonly merge_parsed_source_roots_binary: (a: number, b: number) => [number, number, number];
    readonly model_parameter_metadata: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly model_parameter_metadata_with_source_roots: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly model_parameter_metadata_with_workspace_sources: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly parse: (a: number, b: number) => [number, number, number];
    readonly parse_source_root_file: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly prebuilt_artifact_key: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly precompiled_runtime_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly prime_source_root_completion_cache: () => [number, number, number];
    readonly render_target: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly render_target_for_source: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly render_target_with_workspace_sources: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly scenario_default_scenario_config: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly scenario_get_codegen_config: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scenario_get_scenario_config: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scenario_get_scenario_config_full: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scenario_get_simulation_config: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly scenario_get_source_roots: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly scenario_get_visualization_config: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scenario_reset_simulation_preset: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scenario_set_codegen_config: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly scenario_set_scenario_config: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scenario_set_simulation_preset: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly scenario_set_source_roots: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly scenario_set_visualization_config: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly simulate_model: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly simulate_model_with_workspace_sources: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly sync_workspace_sources: (a: number, b: number) => [number, number, number, number];
    readonly wasm_init: (a: number) => number;
    readonly init: () => void;
    readonly compile_to_json: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly sin: (a: number) => number;
    readonly cos: (a: number) => number;
    readonly exp: (a: number) => number;
    readonly log: (a: number) => number;
    readonly log10: (a: number) => number;
    readonly pow: (a: number, b: number) => number;
    readonly atan2: (a: number, b: number) => number;
    readonly tan: (a: number) => number;
    readonly asin: (a: number) => number;
    readonly acos: (a: number) => number;
    readonly atan: (a: number) => number;
    readonly sinh: (a: number) => number;
    readonly cosh: (a: number) => number;
    readonly tanh: (a: number) => number;
    readonly abs: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
