import { Placeholder, ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";

export function Players() {
  const t = useT();
  return (
    <>
      <ScreenHeader title={t.screens.players.title} lead={t.screens.players.lead} />
      <Placeholder>{t.placeholder}</Placeholder>
    </>
  );
}
