/**
 * DSH Studio test bundle — a minimal Cordis plugin used to exercise the
 * plugin-market install/activate path end to end. Not shipped with the app.
 */
export default function dshStudioTestBundle(ctx) {
	console.log("[test-bundle] active");
	ctx.on("ready", () => {
		console.log("[test-bundle] tree ready");
	});
}

export { dshStudioTestBundle as apply };
