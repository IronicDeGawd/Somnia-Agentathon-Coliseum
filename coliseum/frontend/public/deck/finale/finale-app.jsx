// finale-app.jsx — root wiring for the Coliseum finale deck

const SCENES = [Scene1, Scene2, Scene3, Scene4, SceneArch, SceneAgents, Scene5, Scene6];

function FinaleApp() {
  return <Deck scenes={SCENES} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<FinaleApp />);
