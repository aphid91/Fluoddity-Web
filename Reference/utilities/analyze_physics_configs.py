import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

def load_physics_configs(config_dir):
    """
    Load all JSON files from the physics_configs directory and extract physics parameters.

    Returns:
        dict: Dictionary with parameter names as keys and numpy arrays of values
    """
    config_path = Path(config_dir)
    json_files = list(config_path.glob("*.json"))

    # Initialize dictionary to store all parameter values
    physics_data = {
        'axial_force': [],
        'lateral_force': [],
        'sensor_gain': [],
        'mutation_scale': [],
        'drag': [],
        'strafe_power': [],
        'sensor_angle': [],
        'global_force_mult': [],
        'sensor_distance': [],
        'trail_persistence': [],
        'trail_diffusion': [],
        'hazard_rate': []
    }

    # Load each JSON file and extract physics parameters
    for json_file in json_files:
        try:
            with open(json_file, 'r') as f:
                data = json.load(f)

            # Extract physics parameters if they exist
            if 'physics' in data:
                physics = data['physics']
                for param in physics_data.keys():
                    if param in physics:
                        physics_data[param].append(physics[param])
        except Exception as e:
            print(f"Error reading {json_file.name}: {e}")

    # Convert lists to numpy arrays
    for param in physics_data:
        physics_data[param] = np.array(physics_data[param])

    return physics_data

def plot_histograms(physics_data):
    """
    Create a 3x4 grid of histograms showing the distribution of each physics parameter.

    Args:
        physics_data: Dictionary with parameter names as keys and numpy arrays as values
    """
    # Create figure with 3x4 subplots
    fig, axes = plt.subplots(3, 4, figsize=(16, 10))
    fig.suptitle('Physics Parameter Distributions Across All Configs', fontsize=16, fontweight='bold')

    # Flatten axes array for easier iteration
    axes_flat = axes.flatten()

    # Parameter names for nice labels
    param_labels = {
        'axial_force': 'Axial Force',
        'lateral_force': 'Lateral Force',
        'sensor_gain': 'Sensor Gain',
        'mutation_scale': 'Mutation Scale',
        'drag': 'Drag',
        'strafe_power': 'Strafe Power',
        'sensor_angle': 'Sensor Angle',
        'global_force_mult': 'Global Force Mult',
        'sensor_distance': 'Sensor Distance',
        'trail_persistence': 'Trail Persistence',
        'trail_diffusion': 'Trail Diffusion',
        'hazard_rate': 'Hazard Rate'
    }

    # Plot histogram for each parameter
    for idx, (param, values) in enumerate(physics_data.items()):
        ax = axes_flat[idx]

        # Create histogram
        ax.hist(values, bins=20, color='steelblue', edgecolor='black', alpha=0.7)

        # Set title and labels
        ax.set_title(param_labels[param], fontweight='bold')
        ax.set_xlabel('Value')
        ax.set_ylabel('Count')

        # Add statistics as text
        mean_val = np.mean(values)
        std_val = np.std(values)
        min_val = np.min(values)
        max_val = np.max(values)

        stats_text = f'n={len(values)}\nμ={mean_val:.3f}\nσ={std_val:.3f}\nmin={min_val:.3f}\nmax={max_val:.3f}'
        ax.text(0.98, 0.97, stats_text, transform=ax.transAxes,
                verticalalignment='top', horizontalalignment='right',
                bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5),
                fontsize=8, family='monospace')

        # Grid for easier reading
        ax.grid(True, alpha=0.3, linestyle='--')

    plt.tight_layout()
    return fig

def print_summary_statistics(physics_data):
    """
    Print summary statistics for all parameters.

    Args:
        physics_data: Dictionary with parameter names as keys and numpy arrays as values
    """
    print("\n" + "="*80)
    print("PHYSICS PARAMETERS SUMMARY STATISTICS")
    print("="*80)
    print(f"{'Parameter':<20} {'Count':<8} {'Mean':<12} {'Std':<12} {'Min':<12} {'Max':<12}")
    print("-"*80)

    for param, values in physics_data.items():
        count = len(values)
        mean = np.mean(values)
        std = np.std(values)
        min_val = np.min(values)
        max_val = np.max(values)

        print(f"{param:<20} {count:<8} {mean:<12.4f} {std:<12.4f} {min_val:<12.4f} {max_val:<12.4f}")

    print("="*80 + "\n")

def main():
    # Path to physics configs directory
    config_dir = "physics_configs"

    print(f"Loading physics configurations from: {config_dir}")

    # Load all physics data
    physics_data = load_physics_configs(config_dir)

    # Print summary statistics
    print_summary_statistics(physics_data)

    # Create and display histograms
    print("Generating histograms...")
    fig = plot_histograms(physics_data)

    # Save the figure
    output_file = "physics_parameters_analysis.png"
    plt.savefig(output_file, dpi=300, bbox_inches='tight')
    print(f"Saved histogram plot to: {output_file}")

    # Display the plot
    plt.show()

if __name__ == "__main__":
    main()
