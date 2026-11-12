// Only has to type-check, with each way of resolving modules that people use, and bundle.
import { createPandocsClient } from "@pandocs/client";
import "@pandocs/embed";
import { PandocsDoc } from "@pandocs/embed/react";

export const client = createPandocsClient({ server: "https://docs.example.com", token: "pd_try" });
export const Page = () => <PandocsDoc server="https://docs.example.com" app="helpdesk" space="handbook" path="guide" getToken={async () => "token"} />;
