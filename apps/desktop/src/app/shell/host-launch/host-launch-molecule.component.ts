import { Component, inject } from "@angular/core";
import { HostLaunchService } from "../../native/host-launch.service";
import { ButtonAtom } from "../../ui/button/button-atom.component";

@Component({
  selector: "praxis-host-launch",
  imports: [ButtonAtom],
  templateUrl: "./host-launch-molecule.component.html",
  styleUrl: "./host-launch-molecule.component.css",
  host: { "[hidden]": "!host.native" },
})
export class HostLaunchMolecule {
  protected readonly host = inject(HostLaunchService);
}
