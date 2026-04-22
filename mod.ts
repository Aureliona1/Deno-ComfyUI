// deno-lint-ignore-file no-explicit-any
import { clog, sleep } from "@aurellis/helpers";
import * as path from "@std/path";

async function streamLogger(reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>) {
	while (true) {
		const { value, done } = await reader.read();
		if (value) {
			const lines = new TextDecoder().decode(value).trimStart().trimEnd().replaceAll("\r", "").split("\n");
			for (const line of lines) {
				if (line.length) clog(line, "Log", "ComfyUI");
			}
		}
		if (done) break;
	}
}

/**
 * An instance of a ComfyUI process. Or the API for an alrady running ComfyUI server.
 */
export class Comfy {
	/**
	 * A class that manages a ComfyUI server. The server can also be running externally on the specified port and this class will still work.
	 * This constructor will signal the server to be initialised if it isn't already, but will not wait for the initialisation to finish.
	 * @param comfyFolder The relative folder to the ComfyUI install, do not provide the path to main.py, just the folder that it is in.
	 * @param PORT The port to run the server on, or that a server is currently already running on.
	 */
	constructor(
		private readonly comfyFolder: string,
		readonly PORT = 8000
	) {
		this.init();
	}

	/**
	 * Close the comfyUI server and read remaining output.
	 */
	async close(): Promise<void> {
		if (this._proc) {
			this._proc.kill();
			await Promise.all([this.stderrReader, this.stdoutReader]);
		}
	}

	/**
	 * Waits until the server is running, or any other server is responding on the ComfyUI port.
	 * @param pollRate The rate in ms to poll the server.
	 */
	async serverReady(pollRate = 500) {
		await this.init();
		let alive = false;
		while (!alive) {
			try {
				const res = await fetch(`http://localhost:${this.PORT}`, { method: "HEAD" });
				alive = res.ok;
			} catch {
				await sleep(pollRate);
			}
		}
	}

	/**
	 * Get the status of a prompt by the prompt id.
	 * @param id The id of the prompt.
	 * @returns The status of the prompt.
	 */
	async getJobHistory(id: string): Promise<ComfyHistoryResponse> {
		await this.serverReady();
		return await (await fetch(`http://localhost:${this.PORT}/history/${id}`)).json();
	}

	/**
	 * Prompt ComfyUI with a workflow.
	 * @param workflow The workflow prompt.
	 * @returns A comfy prompt reponse including the prompt id for managing output.
	 */
	async prompt(workflow: Workflow): Promise<ComfyPromptResponse> {
		await this.serverReady();
		return await (await fetch(`http://localhost:${this.PORT}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: workflow }) })).json();
	}

	/**
	 * Managed process.
	 */
	private _proc: Deno.ChildProcess | null = null;

	/**
	 * Ensures that something is running on the specified port. Returns false if that thing isn't a managed ComfyUI process.
	 */
	private async init(): Promise<boolean> {
		try {
			const res = await fetch(`http://localhost:${this.PORT}`, { method: "HEAD" });
			if (!res.ok) {
				clog(`😯 Something is running on the ComfyUI port: ${this.PORT}, but it isn't ComfyUI. Please close whatever it is and try again...`, "Error");
			} else return false;
		} catch {
			if (this._proc === null) {
				this._proc = new Deno.Command("python", { args: [path.join(this.comfyFolder, "main.py"), "--listen", "0.0.0.0", "--port", this.PORT.toString()], stdout: "piped", stderr: "piped" }).spawn();
				this.onProcReady(this._proc);
			}
		}
		return true;
	}

	private stderrReader: Promise<void> | null = null;
	private stdoutReader: Promise<void> | null = null;

	/**
	 * Code to run when proc is running.
	 */
	private onProcReady(proc: Deno.ChildProcess) {
		this.stderrReader = streamLogger(proc.stderr.getReader());
		this.stdoutReader = streamLogger(proc.stdout.getReader());
	}
}

/**
 * The response shape from polling the history of a prompt id.
 */
export type ComfyHistoryResponse = Record<string, ComfyHistoryEntry>;

/**
 * The shape of a response from the history endpoint.
 */
export interface ComfyHistoryEntry {
	/**
	 * The original prompt.
	 */
	prompt: ComfyPromptTuple;
	/**
	 * Outputs from this job.
	 */
	outputs?: Record<string, ComfyNodeOutput>;
	/**
	 * The status of this job.
	 */
	status?: ComfyExecutionStatus;
}

/**
 * The prompt tuple collection in history. Includes the original configuration.
 *
 * - queue position
 * - prompt id
 * - original workflow
 * - extra metadata
 */
export type ComfyPromptTuple = [
	number, // queue index
	string, // prompt_id
	Workflow,
	Record<string, unknown> // extra metadata (often empty)
];

/**
 * A workflow to prompt the server with.
 */
export type Workflow = Record<
	string, // node id
	{
		inputs: Record<string, unknown>;
		class_type: string;
		_meta?: {
			title?: string;
		};
	}
>;

/**
 * Specifies the output of "output" nodes in the workflow.
 */
export interface ComfyNodeOutput {
	/**
	 * Any image output of this node.
	 */
	images?: ComfyImageOutput[];
	/**
	 * Any gif output of this node.
	 */
	gifs?: ComfyImageOutput[];
	/**
	 * Any audio output of this node.
	 */
	audio?: ComfyAudioOutput[];
	/**
	 * Any text output of this node.
	 */
	text?: string[];
	/**
	 * Just to allow custom outputs.
	 */
	[key: string]: unknown;
}

/**
 * An image output collection. Specifies the location of generated images.
 */
export interface ComfyImageOutput {
	/**
	 * The image basename.
	 */
	filename: string;
	/**
	 * The subfolder of the "output" folder to find this image.
	 */
	subfolder: string;
	/**
	 * This will almost always be "output".
	 */
	type: string;
}

/**
 * An audio output collection. Specifies the location of generated audio.
 */
export interface ComfyAudioOutput {
	/**
	 * The basename of the audio file.
	 */
	filename: string;
	/**
	 * The subfolder of the "output" folder to find this audio.
	 */
	subfolder: string;
	/**
	 * This will almost always be "output".
	 */
	type: string;
}

/**
 * The execution status of a job.
 */
export interface ComfyExecutionStatus {
	/**
	 * Generic status string.
	 */
	status_str: "success" | "error" | string;
	/**
	 * Job complete.
	 */
	completed: boolean;
	/**
	 * Additional messages about the job.
	 */
	messages?: string[];
}

// ComfyUI /prompt response type definitions

/**
 * Response returned after POSTing to /prompt
 * when a workflow is successfully queued.
 */
export interface ComfyPromptResponse {
	/**
	 * The id of the queued prompt.
	 */
	prompt_id: string;
	/**
	 * Bad naming by ComfyUI, but this is the queue position of the prompt.
	 */
	number: number;
	/**
	 * A collection of errors for nodes.
	 */
	node_errors?: ComfyNodeErrors;
}

/**
 * Map of node id -> error information.
 * Present if validation fails for one or more nodes.
 */
export type ComfyNodeErrors = Record<string, ComfyNodeError>;

/**
 * A ComfyUI response interface for errors relating to nodes.
 */
export interface ComfyNodeError {
	/**
	 * The errors themselves.
	 */
	errors: ComfyNodeValidationError[];
	/**
	 * A list of the inputs that rely on this node's output.
	 */
	dependent_outputs?: string[];
	/**
	 * The class type of the erroring node.
	 */
	class_type?: string;
}

/**
 * Individual validation error entry.
 */
export interface ComfyNodeValidationError {
	/**
	 * The error type.
	 */
	type: string;
	/**
	 * Human readable error context.
	 */
	message: string;
	/**
	 * Potential additional context.
	 */
	details?: any;
}
