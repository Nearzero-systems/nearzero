import { trpcMutate } from "@/lib/client-api";
import { showToast } from "@/scripts/ui";

export function bindProjectWorkspace() {
	const saveBtn = document.getElementById("nz-project-env-save");
	if (saveBtn instanceof HTMLButtonElement && saveBtn.dataset.nzEnvBound !== "1") {
		saveBtn.dataset.nzEnvBound = "1";
		saveBtn.addEventListener("click", async () => {
			const projectInput = document.getElementById("nz-project-env-project-id");
			const editor = document.getElementById("nz-project-env-editor");
			const projectId =
				projectInput instanceof HTMLInputElement ?
					projectInput.value.trim()
				:	"";
			if (!(editor instanceof HTMLTextAreaElement) || editor.readOnly) return;
			const env = editor.value;
			if (!projectId) return;
			saveBtn.disabled = true;
			try {
				await trpcMutate("project.update", { projectId, env });
				showToast("Project environment variables saved", "success");
			} catch (err) {
				showToast(
					err instanceof Error ?
						err.message
					:	"Error saving environment variables",
					"error",
				);
			} finally {
				saveBtn.disabled = false;
			}
		});
	}
}
