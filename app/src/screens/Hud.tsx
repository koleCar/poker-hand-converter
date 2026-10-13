import { Placeholder, ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";

export function Hud() {
  const t = useT();
  return (
    <>
      <ScreenHeader title={t.screens.hud.title} lead={t.screens.hud.lead} />
      <Placeholder>{t.placeholder}</Placeholder>
    </>
  );
}
