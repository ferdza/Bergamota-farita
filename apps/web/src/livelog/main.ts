import { mount } from "svelte";
import "../styles/base.css";
import LiveLog from "./LiveLog.svelte";

mount(LiveLog, { target: document.getElementById("app")! });
