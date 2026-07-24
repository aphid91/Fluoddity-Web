
![bubbles 12 46 01 (1)](https://github.com/user-attachments/assets/ecd4a0dc-a11f-45b3-b603-b4e27e8e576b)
# Fluoddity
I struggle to describe Fluoddity. Think somewhere between interactive lava lamp and evolvable ant farm. 
Sometimes I'll see a meandering river, a candle flame, or branching lightning. Sometimes it's more like looking under a microscope as little amoebas devour each other and break apart. And sometimes, it's stranger than all that.

## WebGL Demo: https://aphid91.github.io/Fluoddity-Core/
<img width="1920" height="1129" alt="lavalamp_20260120_152448" src="https://github.com/user-attachments/assets/e8eda829-40d1-4add-afd6-80548a34cf5c" />
<img width="1920" height="1129" alt="lavalamp_20260120_152543" src="https://github.com/user-attachments/assets/6bf3ce1c-8a7f-487f-ad9e-1da67f73686c" />
<img width="1920" height="1129" alt="lavalamp_20260120_152527" src="https://github.com/user-attachments/assets/f1c1b933-f5fd-4802-b2b6-7887d483b71d" />

Fluoddity is a 2d particle system designed for realtime exploration. I've been tinkering with this idea for years, and it still feels like there's an ocean of possibilities I have yet to fully explore (3d generalization chief among them). There is a well considered algorithm that runs the actual physics, with an extensively Claude-Coded user interface built around it. 
The physics engine itself is a generalization of this excellent Sage Jenson page about physarum transport models: 
https://cargocollective.com/sagejenson/physarum

I strongly recommend reading at least the first few paragraphs if you want to understand how this project works. 
## Fluoddity-Core: https://github.com/aphid91/Fluoddity-Core
The algorithm that drives the Fluoddity particle system is pretty simple, but Fluoddity itself has a lot of bells and whistles. Fluoddity-Core exists as a minimal shell that is easier to understand and tinker with. It has just enough machinery to load and run a basic Fluoddity config with no UI fluff. Fluoddity-Core also hosts a Claude-Code port of the core engine to webgl that runs on github pages (This is the demo linked above).
Any advice or criticism is welcome. This is a toy I made for myself and I am more artist than engineer. 

## Features
 - "physics sliders" to customize simulation parameters.
 - particle selection/mutation to customize particle behavior
 - mouse drawing mode for making trails
 - Save/load system for physics + behavior
 - save strings with copy/paste from clipboard
 - parameter sweeps mode allows varying physics sliders across the canvas. X and Y sweeps for exploring 2d parameter space.
 - variable physics frequency with motion blur
 - ffmpeg based video recording
 - Emboss visual effect (currently the only use for traditional density trails)
 - Experimental system for mixing different saved configs.
## Design
Particles in Fluoddity have no direct interactions with each-other. Instead, they leave trails as they move. These trails decay and diffuse over time. Particles respond to the density and direction of trails around them.
There is no fixed rule that determines how particles respond to their senses. Instead, each particle has a simple neural-net like brain with just 80 parameters. These parameters are randomized on startup, and then mutated as the user selects which lineages to explore.

## Screenshots
<img width="797" height="595" alt="image" src="https://github.com/user-attachments/assets/343b2f6a-c09b-41c1-a370-247c223c33a7" />
<img width="797" height="597" alt="image" src="https://github.com/user-attachments/assets/c70ce389-fe63-4635-bb5f-bbd62bd7a317" />


## Model
Fluoddity generalizes the traditional physarum model in a couple ways.
### Trail interference
Particle trails have a velocity/flow vector which records the net "current" of particles. Thus, particle trails can interfere, and the trails from an equal number of particles flowing in opposite directions will cancel out.
### Behavior - Rules
Particle behavior is governed by a somewhat arbitrary black box function called a 'Rule'. I use a simple sum of sin waves because i wanted smooth, periodic noise. Trail sensor values are fed into this noise function, and the outputs are used to accelerate and reposition the particle.
### "Strafe"
In addition to forces causing acceleration, each paricle has a limited ability to "strafe", changing position independently from velocity. This is the least "principled" of my generalizations, but it is incredibly simple and enables some really beautiful patterns. Strafe allows particles to leave velocity trails which disagree with their direction of travel, enabling things like "swimming upstream" without turning around or "sidle to the left" without losing track of which way is "forward". 
### Symmetry
The traditional physarum model has some important symmetries that we would like to impose on our otherwise arbitrary noise functions. These symmetries can be toggled (or dialed down) in additional settings.

- Rotational: 
Rotate the whole world by 90°, and nothing should change: the dynamics are independent of global orientation. Particles should never favor the bottom left corner of the screen, for example. Achieving this symmetry is as simple as calculating all sensors/forces in a local coordinate system where "up" == particle velocity.

- Chiral:
Reflect the world across the X axis and nothing should change: the dynamics are identical when viewed in a mirror. Particles in the traditional physarum model display bilateral symmetry, they are not "left handed" or "right handed". Without this property, fluoddity particles show clockwise/counterclockwise bias, and the behavior space consists mostly of particles which are always turning left, or always turning right. This symmetry is achieved by calculating physics twice: once in mirrored coordinates, and averaging the results.

Enforcing these symmetries drastically reduces the prevalence of boring and degenerate Rules.

### Future Exploration
- Trail diffusion step replaced with arbitrary continuous cellular automata. wave equation or advection along flow lines could be interesting
- More than just two sensors.
- Disentangle "local orientation" from "particle velocity". Strafe mechanic hints at this being worthwhile.
- Particle internal state/ memory. Current particle behavior is memoryless aside from velocity persistence.
- Trails need not correspond to particle velocity. "Trail vector" could be just another output of the Rule function. Trail dimensionality could be increased.
- A more universal framework for describing these kinds of systems. One could generalize all the way to continuous cellular automata + continuous turmites.
  
### Requirements

- Python 3.x
- OpenGL-compatible graphics card

### Setup

1. Clone this repository
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Usage
Either:
pip install requirements, then run main.py
OR
Download a release and run Fluoddity.exe 

## Building

For instructions on building a standalone executable, see [BUILD.md](BUILD.md).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
