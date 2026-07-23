"""Generic, stateless OpenGL helpers shared across modules.

This module is the sanctioned "shared util" exception to the module-per-folder
rule: it holds no domain state. The only mutable module-level state is
MUTED_TRYSET_WARNINGS, a purely diagnostic warning-suppression counter that does
not interface with any other part of the program.
"""

import moderngl


def read_shader(path: str) -> str:
    with open(path, 'r') as file:
        return file.read()


MUTED_TRYSET_WARNINGS = {}


def tryset(program: moderngl.Program, uniform, value):
    """
    Gracefully handle a uniform that doesn't appear in program.
    Uniforms are frequently optimized out if they are not used in the current version of the shader.
    """
    if uniform in program:
        program[uniform] = value
    else:
        global MUTED_TRYSET_WARNINGS
        if uniform not in MUTED_TRYSET_WARNINGS:
            MUTED_TRYSET_WARNINGS[uniform] = 0
        MUTED_TRYSET_WARNINGS[uniform] += 1
        if MUTED_TRYSET_WARNINGS[uniform] < 10:
            print('Warning: ', uniform, ' not present in ', program)
