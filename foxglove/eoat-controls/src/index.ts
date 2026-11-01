import { ExtensionContext } from "@foxglove/extension";

import { initCatalogPanel } from "./CatalogPanel";
import { initFocusPanel } from "./FocusPanel";
import { initLightingPanel } from "./LightingPanel";
import { initViewpointGenerationPanel } from "./ViewpointGenerationPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "EOAT Lighting", initPanel: initLightingPanel });
  extensionContext.registerPanel({ name: "EOAT Focus", initPanel: initFocusPanel });
  extensionContext.registerPanel({ name: "PLM Catalog", initPanel: initCatalogPanel });
  extensionContext.registerPanel({
    name: "Viewpoint Generation",
    initPanel: initViewpointGenerationPanel,
  });
}
