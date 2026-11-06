import { mountThemedPage } from "../themedPage";
import KitchenSink from "./KitchenSink";

// The kitchen sink, served at `/kitchen-sink.html`: every piece of low-level UI
// that carries color, on one page, for tuning the palette in app.css with
// Vite's hot reloading. The themed-page shell is in `../themedPage.tsx`.
mountThemedPage("Kitchen sink", KitchenSink);
