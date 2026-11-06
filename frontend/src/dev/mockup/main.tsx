import { mountThemedPage } from "../themedPage";
import Mockup from "./Mockup";

// The mockup, served at `/mockup.html`: a miniature of the whole app in both
// themes. The themed-page shell is in `../themedPage.tsx`.
mountThemedPage("Mockup", Mockup);
