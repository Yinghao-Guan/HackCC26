import type { Metadata } from "next";
import { CameraTest } from "@/components/camera/CameraTest";

export const metadata: Metadata = {
  title: "HackCC26 Camera test",
  description: "Try a camera setup: hand tracking, writing pose and shadow brightness.",
};

export default function CameraTestPage() {
  return <CameraTest />;
}
