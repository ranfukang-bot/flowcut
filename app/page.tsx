import { StudioApp } from "./studio-app";
import { AdminApp } from "./admin-app";
import { runtimeEnv } from "../lib/storage";

export default function Home() {
  return runtimeEnv().FLOWCUT_CONTROL_PLANE === "1" ? <AdminApp /> : <StudioApp />;
}
