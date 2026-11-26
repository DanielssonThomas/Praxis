import { Component } from "@angular/core";
import { SetupGuideOrganism } from "./guide/setup-guide-organism.component";

@Component({
  selector: "praxis-setup",
  imports: [SetupGuideOrganism],
  templateUrl: "./setup-template.component.html",
  styleUrl: "./setup-template.component.css",
})
export class SetupTemplate {}
