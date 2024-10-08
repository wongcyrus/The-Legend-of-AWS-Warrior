import { entity } from "./entity.js";
import { baseUrl } from "./constant.js";

export const quest_component = (() => {
  const _TITLE = "Welcome Adventurer!";
  const _TEXT = `Welcome to Honeywood adventurer, I see you're the chosen one and also the dragon born and whatever else, you're going to save the world! Also bring the rings back to mordor and defeat the evil dragon, and all the other things. But first, I must test you with some meaningless bullshit tasks that every rpg makes you do to waste time. Go kill like uh 30 ghosts and collect their eyeballs or something. Also go get my drycleaning and pick up my kids from daycare.`;

  class QuestComponent extends entity.Component {
    constructor() {
      super();

      const e = document.getElementById("quest-ui");
      e.style.visibility = "hidden";
    }

    InitComponent() {
      this._RegisterHandler("input.picked", (m) => this._OnPicked(m));
    }

    _hashCode(s) {
      return s.split("").reduce(function (a, b) {
        a = (a << 5) - a + b.charCodeAt(0);
        return a & a;
      }, 0);
    }

    _OnPicked(msg) {
      const urlWithQueryParams = new URL(baseUrl + "game");
      urlWithQueryParams.searchParams.append("mode", "game");
      fetch(urlWithQueryParams, {
        headers: {
          "x-api-key": localStorage.getItem("api_key")
        }
      })
        .then((response) => response.json())
        .then((data) => {
          // Process the data here
          if (typeof data === "string") {
            const quest = {
              id: this._hashCode(data),
              title: "Hi there!",
              text: data,
            };
            this._AddQuestToJournal(quest);
            return;
          }

          console.log(data[0]);
          const task = data[0];
          const quest = {
            id: task.name.replace(/\./g, "_"),
            title: task.name.split("_").pop(),
            text: task.instruction,
          };
          localStorage.setItem("filter", task.filter);
          this._AddQuestToJournal(quest);
        })
        .catch((error) => {
          // Handle any errors here
          console.error(error);
        });
    }

    _AddQuestToJournal(quest) {
      const ui = this.FindEntity("ui").GetComponent("UIController");
      ui.AddQuest(quest);
    }
  }

  return {
    QuestComponent: QuestComponent,
  };
})();
